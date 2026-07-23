/* eslint-disable react-hooks/refs --
 * This component implements an imperative long-press drag with core
 * PanResponder (no gesture-handler / reanimated). Its gesture handlers and the
 * drop hit-test read refs — the armed flag, the long-press timer, the latest
 * parent callbacks, and the measured day-target rects — at gesture-EVENT time,
 * never to compute JSX during render. The react-hooks/refs rule targets
 * render-phase ref reads and can't tell the two apart, so it is disabled for
 * this file. (Direct mutation of a useState holder is what react-hooks
 * /immutability forbids, so refs — not a mutable useState object — are correct
 * here.)
 */
import { useEffect, useMemo, useRef, useState } from "react";
import {
  Animated,
  PanResponder,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
  type GestureResponderEvent,
  type PanResponderGestureState,
} from "react-native";

import { type BoardColor, type ScheduledShiftDto } from "../api";
import { haptics } from "../lib/haptics";
import { lightColors as c, radii, spacing } from "../theme";

const DOW = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

function pad(n: number): string {
  return n.toString().padStart(2, "0");
}

/** Parse a `YYYY-MM-DD` day key into a LOCAL Date (device zone), matching how
 *  ScheduleScreen derives day keys from shift times. */
function localDate(key: string): Date {
  const [y, m, d] = key.split("-").map(Number);
  return new Date(y ?? 1970, (m ?? 1) - 1, d ?? 1);
}

function clock(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "--:--";
  let h = d.getHours();
  const m = d.getMinutes();
  const ampm = h >= 12 ? "PM" : "AM";
  h = h % 12 || 12;
  return `${h}:${pad(m)} ${ampm}`;
}

/** The board palette maps the seven tokens onto the mobile theme (clay=accent,
 *  moss=success, amber=warn, plus four per-theme project colors), so a shift's
 *  project reads the same hue the web board tints it. */
function dotColor(color: BoardColor | null): string | null {
  if (color === "clay") return c.accent;
  if (color === "moss") return c.success;
  if (color === "amber") return c.warn;
  if (color === "slate") return c.projSlate;
  if (color === "plum") return c.projPlum;
  if (color === "pine") return c.projPine;
  if (color === "sand") return c.projSand;
  return null;
}

type TargetRect = { key: string; x: number; y: number; w: number; h: number };

/** A lifted card: which shift, and where it sat when the finger picked it up
 *  (window coordinates, so the overlay can be placed anywhere on screen). */
type Drag = {
  shift: ScheduledShiftDto;
  /** The source card's rect at lift, in window coordinates. */
  rect: { x: number; y: number; w: number; h: number };
  /** The board root's origin at lift, so window coordinates convert to the
   *  overlay's local coordinate space. */
  origin: { x: number; y: number };
};

type Props = {
  /** The 7 day keys of the visible week, Monday first. */
  dayKeys: string[];
  todayKey: string;
  byDay: Map<string, ScheduledShiftDto[]>;
  selectedDayKey: string;
  onSelectDay: (key: string) => void;
  /** false when offline — long-press must not lift a card (manager mutations
   *  are online-only). */
  draggable: boolean;
  onEditShift: (s: ScheduledShiftDto) => void;
  onMoveShift: (s: ScheduledShiftDto, targetKey: string) => void;
  onOfflineBlocked: () => void;
};

export function ScheduleBoard({
  dayKeys,
  todayKey,
  byDay,
  selectedDayKey,
  onSelectDay,
  draggable,
  onEditShift,
  onMoveShift,
  onOfflineBlocked,
}: Props) {
  // Window rects of the 7 day targets, measured when a drag lifts (targets do
  // not move during a drag, so one measurement per lift is enough).
  const targetRefs = useRef<(View | null)[]>([]);
  const targetRectsRef = useRef<TargetRect[]>([]);
  const [drag, setDrag] = useState<Drag | null>(null);
  const [hoverKey, setHoverKey] = useState<string | null>(null);
  // The board root, so a card's window rect converts into overlay coordinates.
  const wrapRef = useRef<View | null>(null);
  // The finger offset. It lives HERE, not in the card, because the thing that
  // moves is the overlay copy at the board root — the card itself must stay
  // put. Transforming the card in place is what used to clip it against the
  // ScrollView and slide it under its siblings.
  const pan = useRef(new Animated.ValueXY({ x: 0, y: 0 })).current;
  // Which lift the current spring-back belongs to, and the spring itself. One
  // shared `pan` serves every card, so a spring left running from card A must
  // never be allowed to tear down card B's drag when it lands.
  const dragSeq = useRef(0);
  const springRef = useRef<Animated.CompositeAnimation | null>(null);

  const measureTargets = () => {
    const rects: TargetRect[] = [];
    targetRefs.current.forEach((ref, i) => {
      const key = dayKeys[i];
      if (!ref || !key) return;
      ref.measureInWindow((x, y, w, h) => {
        rects.push({ key, x, y, w, h });
      });
    });
    // measureInWindow fills `rects` asynchronously; the ref points at the same
    // array, so it sees the pushes as they resolve (well before a drag move,
    // which only starts after the 300ms long-press).
    targetRectsRef.current = rects;
  };

  const hitKey = (x: number, y: number): string | null => {
    const r = targetRectsRef.current.find(
      (t) => x >= t.x && x <= t.x + t.w && y >= t.y && y <= t.y + t.h,
    );
    return r ? r.key : null;
  };

  /** Drop the overlay at once. For a move that lands: the card is about to
   *  reappear under a different day, so animating it home would be a lie. */
  const endDragNow = () => {
    pan.setValue({ x: 0, y: 0 });
    setDrag(null);
    setHoverKey(null);
  };

  /** Float the overlay back to where the card came from, then drop it. For a
   *  release that hit no day: the card is staying put, and it should look
   *  like it went back rather than vanished.
   *
   *  The spring runs for the better part of a second, which is long enough to
   *  lift a second card. So it tears down only the drag it was started for:
   *  `finished` is false when a new lift stopped it, and the sequence check
   *  covers the case where it lands naturally after another card took over. */
  const endDragSpringingBack = () => {
    setHoverKey(null);
    const seq = dragSeq.current;
    const anim = Animated.spring(pan, {
      toValue: { x: 0, y: 0 },
      useNativeDriver: false,
      bounciness: 6,
      speed: 20,
    });
    springRef.current = anim;
    anim.start(({ finished }) => {
      springRef.current = null;
      if (!finished || dragSeq.current !== seq) return;
      pan.setValue({ x: 0, y: 0 });
      setDrag(null);
    });
  };

  const groups = useMemo(() => {
    const list = byDay.get(selectedDayKey) ?? [];
    const m = new Map<string, ScheduledShiftDto[]>();
    for (const s of list) {
      const arr = m.get(s.employeeUserId);
      if (arr) arr.push(s);
      else m.set(s.employeeUserId, [s]);
    }
    return [...m.entries()].map(([uid, shifts]) => ({
      uid,
      name: shifts[0]!.employeeName,
      shifts,
    }));
  }, [byDay, selectedDayKey]);

  return (
    <View
      style={styles.wrap}
      ref={(el) => {
        wrapRef.current = el;
      }}
      collapsable={false}
    >
      {/* Day-target strip. Each cell is a drop target during a drag. */}
      <View style={styles.strip}>
        {dayKeys.map((key, i) => {
          const d = localDate(key);
          const isToday = key === todayKey;
          const isSelected = key === selectedDayKey;
          const isHover = key === hoverKey;
          const count = byDay.get(key)?.length ?? 0;
          return (
            <View
              key={key}
              ref={(el) => {
                targetRefs.current[i] = el;
              }}
              collapsable={false}
              style={[
                styles.target,
                isToday && styles.targetToday,
                isSelected && styles.targetSelected,
                isHover && styles.targetHover,
              ]}
            >
              <Pressable
                onPress={() => onSelectDay(key)}
                style={styles.targetPress}
                accessibilityRole="button"
                accessibilityLabel={`${DOW[d.getDay()]} ${d.getDate()}, ${count} ${count === 1 ? "shift" : "shifts"} scheduled`}
              >
                <Text
                  style={[styles.targetDow, isSelected && styles.targetDowSel]}
                >
                  {DOW[d.getDay()]![0]}
                </Text>
                <Text
                  style={[styles.targetDate, isSelected && styles.targetDateSel]}
                >
                  {d.getDate()}
                </Text>
                {/* How many shifts that day, not merely whether any. A dot
                    answered a question nobody was asking. */}
                {count > 0 ? (
                  <View
                    style={[
                      styles.targetCount,
                      isSelected && styles.targetCountSel,
                    ]}
                  >
                    <Text
                      style={[
                        styles.targetCountText,
                        isSelected && styles.targetCountTextSel,
                      ]}
                    >
                      {count}
                    </Text>
                  </View>
                ) : (
                  <View style={styles.targetCountSpacer} />
                )}
              </Pressable>
            </View>
          );
        })}
      </View>

      <Text style={styles.hint}>
        {draggable
          ? "Hold a shift, then drag it onto a day to move it."
          : "Offline. Connect to move shifts."}
      </Text>

      <ScrollView
        contentContainerStyle={styles.dayBody}
        showsVerticalScrollIndicator={false}
        // A lifted card owns the gesture. Without this the list scrolls under
        // the finger while the card is being dragged.
        scrollEnabled={drag === null}
      >
        {groups.length === 0 ? (
          <Text style={styles.none}>
            No shifts this day. Drag one onto the day above or tap + Add.
          </Text>
        ) : (
          groups.map((g) => (
            <View key={g.uid} style={styles.group}>
              <Text style={styles.groupName}>{g.name}</Text>
              {g.shifts.map((s) => (
                <DraggableShiftCard
                  key={s.id}
                  shift={s}
                  pan={pan}
                  dragging={drag?.shift.id === s.id}
                  draggable={draggable}
                  onLift={(rect) => {
                    // Claim the shared pan: stop any spring still carrying the
                    // last card home, and zero the residual offset so this
                    // card lifts from under the finger rather than from
                    // wherever that spring had got to.
                    dragSeq.current += 1;
                    springRef.current?.stop();
                    springRef.current = null;
                    pan.setValue({ x: 0, y: 0 });
                    measureTargets();
                    // The overlay is positioned inside the board, so convert
                    // the card's window rect through the board's own origin.
                    wrapRef.current?.measureInWindow((wx, wy) => {
                      setDrag({ shift: s, rect, origin: { x: wx, y: wy } });
                    });
                    haptics.medium();
                  }}
                  onBlocked={onOfflineBlocked}
                  onMove={(x, y) => setHoverKey(hitKey(x, y))}
                  onDrop={(x, y) => {
                    const target = hitKey(x, y);
                    const currentKey = dayKeyOf(s.startsAt);
                    // Landed nowhere, or back on the day it came from: the
                    // card stays, so float it home.
                    if (!target || target === currentKey) {
                      endDragSpringingBack();
                      return;
                    }
                    endDragNow();
                    // No haptic here: moveShiftToDay already fires success on
                    // the optimistic move, and two ticks for one drop reads as
                    // a stutter.
                    onMoveShift(s, target);
                  }}
                  onCancel={endDragSpringingBack}
                  onPress={() => onEditShift(s)}
                />
              ))}
            </View>
          ))
        )}
      </ScrollView>

      {/* The dragging card, drawn at the board ROOT above everything else.
          Nothing clips it and nothing z-fights it, which is the whole reason
          it is not simply the source card moved. `pointerEvents="none"` keeps
          the gesture with the source card, which already holds the responder. */}
      {drag ? (
        <Animated.View
          pointerEvents="none"
          style={[
            styles.card,
            styles.cardDragging,
            styles.dragOverlay,
            {
              left: drag.rect.x - drag.origin.x,
              top: drag.rect.y - drag.origin.y,
              width: drag.rect.w,
              transform: pan.getTranslateTransform(),
            },
          ]}
        >
          <View style={styles.cardPress}>
            <View style={styles.cardMain}>
              <Text style={styles.cardTime}>
                {clock(drag.shift.startsAt)} to {clock(drag.shift.endsAt)}
              </Text>
              {drag.shift.projectName ? (
                <View style={styles.cardProjectRow}>
                  {dotColor(drag.shift.projectColor) ? (
                    <View
                      style={[
                        styles.cardDot,
                        { backgroundColor: dotColor(drag.shift.projectColor)! },
                      ]}
                    />
                  ) : null}
                  <Text style={styles.cardProject} numberOfLines={1}>
                    {drag.shift.projectName}
                  </Text>
                </View>
              ) : null}
            </View>
          </View>
        </Animated.View>
      ) : null}
    </View>
  );
}

/** Day key of an ISO instant in the device zone (matches ScheduleScreen). */
function dayKeyOf(iso: string): string {
  const d = new Date(iso);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

type CardProps = {
  shift: ScheduledShiftDto;
  /** The board's shared finger offset. The card writes to it; the board's
   *  overlay copy is what actually moves. */
  pan: Animated.ValueXY;
  dragging: boolean;
  draggable: boolean;
  /** Called with this card's window rect once the long-press arms. */
  onLift: (rect: { x: number; y: number; w: number; h: number }) => void;
  onBlocked: () => void;
  onMove: (x: number, y: number) => void;
  onDrop: (x: number, y: number) => void;
  onCancel: () => void;
  onPress: () => void;
};

const LONG_PRESS_MS = 300;
const MOVE_CANCEL_PX = 8;

function DraggableShiftCard({
  shift,
  pan,
  dragging,
  draggable,
  onLift,
  onBlocked,
  onMove,
  onDrop,
  onCancel,
  onPress,
}: CardProps) {
  // Imperative gesture state (refs, read only inside the gesture handlers
  // below — see the file-level note on react-hooks/refs). `cb` carries the
  // latest parent callbacks so the once-created responder never calls a stale
  // closure after a mid-drag re-render.
  const selfRef = useRef<View | null>(null);
  const armed = useRef(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const cb = useRef({ draggable, onLift, onBlocked, onMove, onDrop, onCancel });
  useEffect(() => {
    cb.current = { draggable, onLift, onBlocked, onMove, onDrop, onCancel };
  });

  /** Hand the parent this card's window rect so the overlay can start exactly
   *  on top of it, then the drag reads as picking the card up rather than a
   *  copy appearing somewhere else. */
  const liftWithRect = () => {
    const node = selfRef.current;
    if (!node) return;
    node.measureInWindow((x, y, w, h) => {
      cb.current.onLift({ x, y, w, h });
    });
  };

  const clearTimer = () => {
    if (timer.current) {
      clearTimeout(timer.current);
      timer.current = null;
    }
  };

  // Clear any pending pre-arm long-press timer if the card unmounts (a move
  // re-renders the day list), so a leaked timeout never lifts a gone card.
  useEffect(() => () => clearTimer(), []);

  // The overlay is unmounted the moment the drag ends, so there is nothing
  // left to spring back — the parent zeroes `pan` in endDrag(). Animating a
  // shared value here would fight the next lift.


  const responder = useRef(
    PanResponder.create({
      // Don't capture on touch-down — a tap (edit) or a scroll must still work.
      onStartShouldSetPanResponder: () => false,
      // Fires on every touch-down (capture, no grab): start the long-press
      // timer that arms the drag.
      onStartShouldSetPanResponderCapture: () => {
        clearTimer();
        armed.current = false;
        timer.current = setTimeout(() => {
          if (!cb.current.draggable) {
            cb.current.onBlocked();
            return;
          }
          armed.current = true;
          liftWithRect();
        }, LONG_PRESS_MS);
        return false;
      },
      // Only claim the gesture once armed. Before arming, a finger that travels
      // is a scroll — cancel the pending lift and let the ScrollView have it.
      onMoveShouldSetPanResponder: (
        _e: GestureResponderEvent,
        gs: PanResponderGestureState,
      ) => {
        if (armed.current) return true;
        if (
          Math.abs(gs.dx) > MOVE_CANCEL_PX ||
          Math.abs(gs.dy) > MOVE_CANCEL_PX
        ) {
          clearTimer();
        }
        return false;
      },
      onMoveShouldSetPanResponderCapture: () => armed.current,
      // An armed drag refuses to hand the gesture back. Without this the
      // parent ScrollView claims the responder the moment the finger travels
      // vertically, onPanResponderTerminate fires, and the drag dies mid-air,
      // which is what "long-press does nothing" actually was.
      onPanResponderTerminationRequest: () => !armed.current,
      onPanResponderMove: (
        _e: GestureResponderEvent,
        gs: PanResponderGestureState,
      ) => {
        pan.setValue({ x: gs.dx, y: gs.dy });
        cb.current.onMove(gs.moveX, gs.moveY);
      },
      onPanResponderRelease: (
        _e: GestureResponderEvent,
        gs: PanResponderGestureState,
      ) => {
        clearTimer();
        if (armed.current) {
          armed.current = false;
          cb.current.onDrop(gs.moveX, gs.moveY);
        }
      },
      onPanResponderTerminate: () => {
        clearTimer();
        if (armed.current) {
          armed.current = false;
          cb.current.onCancel();
        }
      },
    }),
  ).current;

  const dot = dotColor(shift.projectColor);

  return (
    <View
      {...responder.panHandlers}
      ref={(el) => {
        selfRef.current = el;
      }}
      collapsable={false}
      // A quick tap never arms the timer's lift; clear it on release so a
      // pending lift can't fire after the finger is gone.
      onTouchEnd={() => {
        if (!armed.current) clearTimer();
      }}
      onTouchCancel={() => {
        clearTimer();
        armed.current = false;
      }}
      // While lifted this card stays exactly where it is and just dims: it is
      // the hole the card came out of. The board's overlay copy is the thing
      // that follows the finger.
      style={[styles.card, dragging && styles.cardSource]}
    >
      <Pressable
        onPress={() => {
          // If the long-press armed but the finger lifted WITHOUT moving, the
          // parent PanResponder was never granted (it only claims on a move),
          // so this Pressable still gets the press. Treat it as a cancelled
          // lift — clear the parent's dragging highlight and do NOT open the
          // edit sheet. A normal tap never arms, so it still edits.
          if (armed.current) {
            armed.current = false;
            onCancel();
            return;
          }
          onPress();
        }}
        style={styles.cardPress}
        accessibilityRole="button"
        accessibilityLabel={`${shift.employeeName}, ${clock(shift.startsAt)} to ${clock(shift.endsAt)}${
          shift.projectName ? `, ${shift.projectName}` : ""
        }. Double tap to edit; press and hold to move.`}
      >
        <View style={styles.cardMain}>
          <Text style={styles.cardTime}>
            {clock(shift.startsAt)} to {clock(shift.endsAt)}
          </Text>
          {shift.projectName ? (
            <View style={styles.cardProjectRow}>
              {dot ? (
                <View style={[styles.cardDot, { backgroundColor: dot }]} />
              ) : null}
              <Text style={styles.cardProject} numberOfLines={1}>
                {shift.projectName}
              </Text>
            </View>
          ) : null}
        </View>
        {shift.isSeries ? (
          <Text style={styles.cardSeries} accessibilityLabel="Repeating series">
            ↻
          </Text>
        ) : null}
      </Pressable>
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: { flex: 1 },
  strip: {
    flexDirection: "row",
    paddingHorizontal: spacing.lg,
    gap: 6,
  },
  target: {
    flex: 1,
    borderRadius: radii.md,
    borderWidth: 1,
    borderColor: c.border,
    backgroundColor: c.surface,
    overflow: "hidden",
  },
  targetToday: { borderColor: c.accent },
  targetSelected: { backgroundColor: c.accent, borderColor: c.accent },
  targetHover: {
    borderColor: c.accent,
    borderWidth: 2,
    backgroundColor: "rgba(184,74,44,0.12)",
  },
  targetPress: {
    alignItems: "center",
    paddingVertical: 8,
  },
  targetDow: {
    color: c.textMuted,
    fontSize: 11,
    fontWeight: "700",
    letterSpacing: 0.5,
  },
  targetDowSel: { color: c.accentText },
  targetDate: {
    color: c.text,
    fontSize: 17,
    fontWeight: "700",
    marginTop: 1,
  },
  targetDateSel: { color: c.accentText },
  targetCount: {
    minWidth: 16,
    height: 16,
    borderRadius: 8,
    marginTop: 3,
    paddingHorizontal: 4,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: c.surfaceAlt,
  },
  targetCountSel: { backgroundColor: "rgba(255,255,255,0.22)" },
  targetCountText: {
    color: c.textMuted,
    fontSize: 10,
    fontWeight: "800",
    lineHeight: 13,
  },
  targetCountTextSel: { color: c.accentText },
  /** Keeps every cell the same height on a day with nothing scheduled. */
  targetCountSpacer: { height: 16, marginTop: 3 },
  hint: {
    color: c.textMuted,
    fontSize: 12,
    paddingHorizontal: spacing.xxl,
    paddingTop: 10,
    paddingBottom: 2,
  },
  dayBody: {
    paddingHorizontal: spacing.xxl,
    paddingTop: 6,
    paddingBottom: 24,
  },
  none: { color: c.textMuted, fontSize: 14, paddingVertical: 12 },
  group: { marginTop: 12 },
  groupName: {
    color: c.textMuted,
    fontSize: 13,
    fontWeight: "700",
    letterSpacing: 1,
    textTransform: "uppercase",
    marginBottom: 6,
  },
  card: {
    backgroundColor: c.surface,
    borderColor: c.border,
    borderWidth: 1,
    borderRadius: radii.md,
    marginBottom: 8,
  },
  /** The card left behind: the gap the dragged card came out of. */
  cardSource: { opacity: 0.35, borderColor: c.accent },
  cardDragging: {
    borderColor: c.accent,
    shadowColor: "#000",
    shadowOpacity: 0.18,
    shadowRadius: 10,
    shadowOffset: { width: 0, height: 4 },
    elevation: 8,
  },
  /** The dragged copy, free of the ScrollView that used to clip it. */
  dragOverlay: {
    position: "absolute",
    marginBottom: 0,
    zIndex: 30,
  },
  cardPress: {
    flexDirection: "row",
    alignItems: "center",
    paddingVertical: 12,
    paddingHorizontal: 14,
  },
  cardMain: { flex: 1 },
  cardTime: { color: c.text, fontSize: 15, fontWeight: "600" },
  cardProjectRow: {
    flexDirection: "row",
    alignItems: "center",
    marginTop: 3,
  },
  cardDot: {
    width: 8,
    height: 8,
    borderRadius: 4,
    marginRight: 6,
  },
  cardProject: { color: c.textMuted, fontSize: 13, flexShrink: 1 },
  cardSeries: { color: c.textMuted, fontSize: 16, marginLeft: 10 },
});
