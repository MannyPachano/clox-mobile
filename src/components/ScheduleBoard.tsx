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

/** The board palette maps the three tokens onto the mobile theme (clay=accent,
 *  moss=success, amber=warn), so a shift's project reads the same hue the web
 *  board tints it. */
function dotColor(color: BoardColor | null): string | null {
  if (color === "clay") return c.accent;
  if (color === "moss") return c.success;
  if (color === "amber") return c.warn;
  return null;
}

type TargetRect = { key: string; x: number; y: number; w: number; h: number };

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
  const [draggingId, setDraggingId] = useState<string | null>(null);
  const [hoverKey, setHoverKey] = useState<string | null>(null);

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
    <View style={styles.wrap}>
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
                accessibilityLabel={`${DOW[d.getDay()]} ${d.getDate()}, ${count} scheduled`}
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
                <View
                  style={[
                    styles.targetPip,
                    count > 0 && styles.targetPipOn,
                    isSelected && count > 0 && styles.targetPipSel,
                  ]}
                />
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
      >
        {groups.length === 0 ? (
          <Text style={styles.none}>Nobody scheduled this day</Text>
        ) : (
          groups.map((g) => (
            <View key={g.uid} style={styles.group}>
              <Text style={styles.groupName}>{g.name}</Text>
              {g.shifts.map((s) => (
                <DraggableShiftCard
                  key={s.id}
                  shift={s}
                  dragging={draggingId === s.id}
                  draggable={draggable}
                  onLift={() => {
                    measureTargets();
                    setDraggingId(s.id);
                    haptics.medium();
                  }}
                  onBlocked={onOfflineBlocked}
                  onMove={(x, y) => setHoverKey(hitKey(x, y))}
                  onDrop={(x, y) => {
                    const target = hitKey(x, y);
                    setDraggingId(null);
                    setHoverKey(null);
                    if (!target) return;
                    const currentKey = dayKeyOf(s.startsAt);
                    if (target === currentKey) return;
                    onMoveShift(s, target);
                  }}
                  onCancel={() => {
                    setDraggingId(null);
                    setHoverKey(null);
                  }}
                  onPress={() => onEditShift(s)}
                />
              ))}
            </View>
          ))
        )}
      </ScrollView>
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
  dragging: boolean;
  draggable: boolean;
  onLift: () => void;
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
  const pan = useRef(new Animated.ValueXY({ x: 0, y: 0 })).current;
  const armed = useRef(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const cb = useRef({ draggable, onLift, onBlocked, onMove, onDrop, onCancel });
  useEffect(() => {
    cb.current = { draggable, onLift, onBlocked, onMove, onDrop, onCancel };
  });

  const clearTimer = () => {
    if (timer.current) {
      clearTimeout(timer.current);
      timer.current = null;
    }
  };

  // Clear any pending pre-arm long-press timer if the card unmounts (a move
  // re-renders the day list), so a leaked timeout never lifts a gone card.
  useEffect(() => () => clearTimer(), []);

  const reset = () => {
    Animated.spring(pan, {
      toValue: { x: 0, y: 0 },
      useNativeDriver: false,
      bounciness: 6,
      speed: 20,
    }).start();
  };

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
          cb.current.onLift();
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
        reset();
      },
      onPanResponderTerminate: () => {
        clearTimer();
        if (armed.current) {
          armed.current = false;
          cb.current.onCancel();
        }
        reset();
      },
    }),
  ).current;

  const dot = dotColor(shift.projectColor);

  return (
    <Animated.View
      {...responder.panHandlers}
      // A quick tap never arms the timer's lift; clear it on release so a
      // pending lift can't fire after the finger is gone.
      onTouchEnd={() => {
        if (!armed.current) clearTimer();
      }}
      onTouchCancel={() => {
        clearTimer();
        armed.current = false;
      }}
      style={[
        styles.card,
        {
          transform: pan.getTranslateTransform(),
        },
        dragging && styles.cardDragging,
      ]}
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
    </Animated.View>
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
  targetPip: {
    width: 5,
    height: 5,
    borderRadius: 3,
    marginTop: 4,
    backgroundColor: "transparent",
  },
  targetPipOn: { backgroundColor: c.textMuted },
  targetPipSel: { backgroundColor: c.accentText },
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
  cardDragging: {
    borderColor: c.accent,
    // Lift above the strip and neighbours while dragging.
    zIndex: 20,
    elevation: 8,
    shadowColor: "#000",
    shadowOpacity: 0.18,
    shadowRadius: 10,
    shadowOffset: { width: 0, height: 4 },
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
