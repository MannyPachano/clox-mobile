import { useCallback, useEffect, useMemo, useState } from "react";
import {
  ActivityIndicator,
  Alert,
  RefreshControl,
  ScrollView,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { useFocusEffect } from "@react-navigation/native";
import AsyncStorage from "@react-native-async-storage/async-storage";
import NetInfo from "@react-native-community/netinfo";

import {
  deleteManagerShift,
  getManagerSchedule,
  updateManagerShift,
  type Option,
  type ScheduledShiftDto,
} from "../api";
import { AddShiftModal } from "../components/AddShiftModal";
import { ScheduleBoard } from "../components/ScheduleBoard";
import { haptics } from "../lib/haptics";
import { getOrgTz } from "../lib/org-tz";
import {
  clockInZone,
  wallPartsInZone,
  ymdInZone,
  zonedWallToUtc,
} from "../lib/zoned-time";
import { getAccessToken } from "../supabase";
import { lightColors as c, radii } from "../theme";

type ViewMode = "list" | "board";
const MODE_KEY = "clox.schedule.viewmode.v1";

// Manager screens use the light "paper" theme.

const DOW = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const MONTHS = [
  "Jan", "Feb", "Mar", "Apr", "May", "Jun",
  "Jul", "Aug", "Sep", "Oct", "Nov", "Dec",
];

function pad(n: number): string {
  return n.toString().padStart(2, "0");
}

// The whole week grid — day keys, columns, labels, the query window — lives
// in the ORG's calendar. A schedule describes the site's days; grouping by
// the manager's phone's days shows a night shift under the wrong column and
// disagrees with the web board. Calendar arithmetic runs in UTC space
// (anchored on the org's today), where adding whole days is exact.

/** "YYYY-MM-DD" from a UTC-calendar carrier ms (see mondayUtcOf). */
function keyOfUtc(ms: number): string {
  const d = new Date(ms);
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
}

/** The org day an instant falls on. */
function dayKeyOf(ms: number, tz: string | undefined): string {
  return ymdInZone(ms, tz);
}

function clock(iso: string): string {
  return clockInZone(Date.parse(iso), getOrgTz());
}

/** UTC-midnight ms of the Monday of the org week `offset` weeks from now.
 *  A carrier value: only its UTC calendar fields mean anything. */
function mondayUtcOf(offset: number, tz: string | undefined): number {
  const w = wallPartsInZone(Date.now(), tz);
  const todayUtc = Date.UTC(w.y, w.mo - 1, w.d);
  const dow = new Date(todayUtc).getUTCDay(); // 0 = Sun
  return todayUtc - ((dow + 6) % 7) * 86_400_000 + offset * 7 * 86_400_000;
}

export function ScheduleScreen() {
  const [weekOffset, setWeekOffset] = useState(0);
  const [shifts, setShifts] = useState<ScheduledShiftDto[]>([]);
  const [employees, setEmployees] = useState<Option[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [addOpen, setAddOpen] = useState(false);
  const [editShift, setEditShift] = useState<ScheduledShiftDto | null>(null);
  const [banner, setBanner] = useState<string | null>(null);
  const [mode, setMode] = useState<ViewMode>("list");
  const [selectedDayKey, setSelectedDayKey] = useState(() =>
    dayKeyOf(Date.now(), getOrgTz()),
  );
  const [isOffline, setIsOffline] = useState(false);

  // A render-time module read, not reactive state: the zone lands (via the
  // status fetch) before this tab can be visited, and every data load
  // re-renders. In the deps so a late arrival recomputes next render.
  const tz = getOrgTz();
  const todayKey = useMemo(() => dayKeyOf(new Date().getTime(), tz), [tz]);

  // Restore the last-used List/Board view.
  useEffect(() => {
    AsyncStorage.getItem(MODE_KEY)
      .then((v) => {
        if (v === "board" || v === "list") setMode(v);
      })
      .catch(() => {});
  }, []);

  const changeMode = useCallback((m: ViewMode) => {
    setMode(m);
    AsyncStorage.setItem(MODE_KEY, m).catch(() => {});
  }, []);

  // Manager mutations are online-only; the board blocks a drag when offline.
  useEffect(() => {
    const unsub = NetInfo.addEventListener((state) => {
      setIsOffline(state.isConnected === false);
    });
    return unsub;
  }, []);

  const weekStartUtc = useMemo(
    () => mondayUtcOf(weekOffset, tz),
    [weekOffset, tz],
  );

  // The query window: instants at the org's midnights bounding the week, so
  // the fetched set is exactly what the org-day columns will show.
  const range = useMemo(() => {
    const partsOf = (ms: number) => {
      const d = new Date(ms);
      return {
        y: d.getUTCFullYear(),
        mo: d.getUTCMonth() + 1,
        d: d.getUTCDate(),
        h: 0,
        mi: 0,
      };
    };
    return {
      fromIso: new Date(zonedWallToUtc(partsOf(weekStartUtc), tz)).toISOString(),
      toIso: new Date(
        zonedWallToUtc(partsOf(weekStartUtc + 7 * 86_400_000), tz),
      ).toISOString(),
    };
  }, [weekStartUtc, tz]);

  const days = useMemo(() => {
    const out: { key: string; label: string }[] = [];
    for (let i = 0; i < 7; i++) {
      const d = new Date(weekStartUtc + i * 86_400_000);
      out.push({
        key: keyOfUtc(d.getTime()),
        label: `${DOW[d.getUTCDay()]} · ${MONTHS[d.getUTCMonth()]} ${d.getUTCDate()}`,
      });
    }
    return out;
  }, [weekStartUtc]);

  const weekLabel = useMemo(() => {
    const start = new Date(weekStartUtc);
    const end = new Date(weekStartUtc + 6 * 86_400_000);
    const a = `${MONTHS[start.getUTCMonth()]} ${start.getUTCDate()}`;
    const b =
      end.getUTCMonth() === start.getUTCMonth()
        ? `${end.getUTCDate()}`
        : `${MONTHS[end.getUTCMonth()]} ${end.getUTCDate()}`;
    return `${a} to ${b}`;
  }, [weekStartUtc]);

  const byDay = useMemo(() => {
    const m = new Map<string, ScheduledShiftDto[]>();
    for (const s of shifts) {
      const k = dayKeyOf(Date.parse(s.startsAt), tz);
      const list = m.get(k);
      if (list) list.push(s);
      else m.set(k, [s]);
    }
    return m;
  }, [shifts, tz]);

  const dayKeys = useMemo(() => days.map((d) => d.key), [days]);

  // The board's selected day, clamped to the visible week: derived (not stored
  // via an effect) so navigating weeks falls back to today / the week's first
  // day without a cascading setState.
  const effectiveDayKey = dayKeys.includes(selectedDayKey)
    ? selectedDayKey
    : dayKeys.includes(todayKey)
      ? todayKey
      : (dayKeys[0] ?? todayKey);

  // Move a shift to another day, keeping its org wall-clock time and its
  // duration. The board's columns ARE org days now, so the drop target reads
  // directly as the org calendar date to recompose onto — a drag on a
  // traveling manager's phone never shifts the crew's 9:00 AM. Optimistic:
  // the card jumps immediately and rolls back on failure.
  const moveShiftToDay = useCallback(
    async (shift: ScheduledShiftDto, targetKey: string) => {
      const token = await getAccessToken();
      if (!token) return;
      const zone = getOrgTz();
      const startMs = Date.parse(shift.startsAt);
      const durationMs = Date.parse(shift.endsAt) - startMs;
      const wall = wallPartsInZone(startMs, zone);
      const [ty, tm, td] = targetKey.split("-").map(Number);
      const newStartMs = zonedWallToUtc(
        { y: ty ?? 1970, mo: tm ?? 1, d: td ?? 1, h: wall.h, mi: wall.mi },
        zone,
      );
      const startIso = new Date(newStartMs).toISOString();
      const endIso = new Date(newStartMs + durationMs).toISOString();

      // Roll back by shift id (not a whole-array snapshot) so a concurrent
      // refetch/add/delete during the in-flight save isn't clobbered. Restore
      // the day the user was viewing (the shift's source day) so a failed move
      // doesn't strand them on the now-empty target day.
      const sourceKey = dayKeyOf(startMs, zone);
      setShifts((s) =>
        s.map((x) =>
          x.id === shift.id ? { ...x, startsAt: startIso, endsAt: endIso } : x,
        ),
      );
      setSelectedDayKey(targetKey);
      haptics.success();
      const rollback = () => {
        setShifts((s) =>
          s.map((x) =>
            x.id === shift.id
              ? { ...x, startsAt: shift.startsAt, endsAt: shift.endsAt }
              : x,
          ),
        );
        setSelectedDayKey(sourceKey);
      };
      try {
        const res = await updateManagerShift(token, {
          id: shift.id,
          startIso,
          endIso,
        });
        if (!res.ok) {
          rollback();
          setBanner("Couldn't move the shift. Try again.");
        } else {
          setBanner("Shift moved.");
        }
      } catch {
        rollback();
        setBanner("No connection. Try again.");
      }
    },
    [],
  );

  const load = useCallback(async () => {
    const token = await getAccessToken();
    if (!token) {
      setLoading(false);
      setRefreshing(false);
      return;
    }
    try {
      const res = await getManagerSchedule(token, range.fromIso, range.toIso);
      if (res.ok) {
        setShifts(res.data.shifts);
        setEmployees(res.data.employees);
      }
    } catch {
      // keep last-known schedule on a network blip
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, [range.fromIso, range.toIso]);

  useFocusEffect(
    useCallback(() => {
      void load();
    }, [load]),
  );

  const onRefresh = useCallback(() => {
    setRefreshing(true);
    void load();
  }, [load]);

  const doDelete = useCallback(
    async (shift: ScheduledShiftDto) => {
      const token = await getAccessToken();
      if (!token) return;
      const prev = shifts;
      setShifts((s) => s.filter((x) => x.id !== shift.id));
      try {
        const res = await deleteManagerShift(token, shift.id);
        // 404 = already gone; treat as done.
        if (!res.ok && res.status !== 404) {
          setShifts(prev);
          setBanner("Couldn't remove the shift. Try again.");
        }
      } catch {
        setShifts(prev);
        setBanner("No connection. Try again.");
      }
    },
    [shifts],
  );

  const confirmDelete = useCallback(
    (shift: ScheduledShiftDto) => {
      const when = `${clock(shift.startsAt)} to ${clock(shift.endsAt)}`;
      Alert.alert(
        "Remove shift?",
        shift.isSeries
          ? `${shift.employeeName}, ${when}. This removes only this one shift. Edit the full repeating series on the web.`
          : `${shift.employeeName}, ${when}.`,
        [
          { text: "Cancel", style: "cancel" },
          {
            text: "Remove",
            style: "destructive",
            onPress: () => void doDelete(shift),
          },
        ],
      );
    },
    [doDelete],
  );

  return (
    <SafeAreaView style={styles.container} edges={["top"]}>
      <View style={styles.header}>
        <Text style={styles.title}>Schedule</Text>
        <TouchableOpacity
          style={styles.addBtn}
          onPress={() => setAddOpen(true)}
          activeOpacity={0.85}
        >
          <Text style={styles.addBtnText}>+ Add</Text>
        </TouchableOpacity>
      </View>

      <View style={styles.segment}>
        {(["list", "board"] as const).map((m) => (
          <TouchableOpacity
            key={m}
            style={[styles.segmentBtn, mode === m && styles.segmentBtnOn]}
            onPress={() => changeMode(m)}
            activeOpacity={0.85}
            accessibilityRole="button"
            accessibilityState={{ selected: mode === m }}
          >
            <Text
              style={[
                styles.segmentText,
                mode === m && styles.segmentTextOn,
              ]}
            >
              {m === "list" ? "List" : "Board"}
            </Text>
          </TouchableOpacity>
        ))}
      </View>

      <View style={styles.weekNav}>
        <TouchableOpacity
          onPress={() => setWeekOffset((w) => w - 1)}
          hitSlop={12}
        >
          <Text style={styles.navArrow}>‹</Text>
        </TouchableOpacity>
        <TouchableOpacity onPress={() => setWeekOffset(0)} hitSlop={8}>
          <Text style={styles.weekLabel}>{weekLabel}</Text>
          {weekOffset !== 0 ? (
            <Text style={styles.todayLink}>Jump to this week</Text>
          ) : null}
        </TouchableOpacity>
        <TouchableOpacity
          onPress={() => setWeekOffset((w) => w + 1)}
          hitSlop={12}
        >
          <Text style={styles.navArrow}>›</Text>
        </TouchableOpacity>
      </View>

      {loading ? (
        <View style={styles.center}>
          <ActivityIndicator color={c.accent} size="large" />
        </View>
      ) : mode === "board" ? (
        <ScheduleBoard
          dayKeys={dayKeys}
          todayKey={todayKey}
          byDay={byDay}
          selectedDayKey={effectiveDayKey}
          onSelectDay={setSelectedDayKey}
          draggable={!isOffline}
          onEditShift={(s) => setEditShift(s)}
          onMoveShift={(s, targetKey) => void moveShiftToDay(s, targetKey)}
          onOfflineBlocked={() => {
            haptics.warning();
            setBanner("Offline. Connect to move shifts.");
          }}
        />
      ) : (
        <ScrollView
          contentContainerStyle={styles.body}
          refreshControl={
            <RefreshControl
              refreshing={refreshing}
              onRefresh={onRefresh}
              tintColor={c.accent}
            />
          }
        >
          {days.map((d) => {
            const list = byDay.get(d.key) ?? [];
            return (
              <View key={d.key} style={styles.daySection}>
                <Text style={styles.dayLabel}>{d.label}</Text>
                {list.length === 0 ? (
                  <Text style={styles.none}>Nobody scheduled</Text>
                ) : (
                  list.map((s) => (
                    <TouchableOpacity
                      key={s.id}
                      style={styles.shift}
                      activeOpacity={0.6}
                      onPress={() => setEditShift(s)}
                    >
                      <View style={styles.shiftText}>
                        <Text style={styles.who} numberOfLines={1}>
                          {s.employeeName}
                          {s.isSeries ? (
                            <Text
                              style={styles.badge}
                              accessibilityLabel="Part of a repeating series"
                            >
                              {"  ↻ Repeats"}
                            </Text>
                          ) : null}
                        </Text>
                        <Text style={styles.when}>
                          {clock(s.startsAt)} to {clock(s.endsAt)}
                        </Text>
                      </View>
                      <Text style={styles.remove}>›</Text>
                    </TouchableOpacity>
                  ))
                )}
              </View>
            );
          })}
        </ScrollView>
      )}

      <AddShiftModal
        visible={addOpen || editShift != null}
        employees={employees}
        shift={editShift}
        onClose={() => {
          setAddOpen(false);
          setEditShift(null);
        }}
        onCreated={() => {
          setAddOpen(false);
          setBanner("Shift scheduled.");
          void load();
        }}
        onUpdated={() => {
          setEditShift(null);
          setBanner("Shift updated.");
          void load();
        }}
        onRemove={(s) => {
          setEditShift(null);
          confirmDelete(s);
        }}
      />

      {banner ? (
        <TouchableOpacity style={styles.bannerWrap} onPress={() => setBanner(null)}>
          <Text style={styles.bannerText}>{banner}  (tap to dismiss)</Text>
        </TouchableOpacity>
      ) : null}
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: c.bg },
  header: {
    flexDirection: "row",
    alignItems: "center",
    paddingHorizontal: 24,
    paddingTop: 12,
    paddingBottom: 8,
  },
  title: { color: c.text, fontSize: 28, fontWeight: "800", flex: 1 },
  addBtn: {
    backgroundColor: c.accent,
    borderRadius: radii.md,
    paddingVertical: 9,
    paddingHorizontal: 14,
  },
  addBtnText: { color: c.accentText, fontSize: 14, fontWeight: "700" },
  segment: {
    flexDirection: "row",
    marginHorizontal: 24,
    marginTop: 4,
    padding: 3,
    backgroundColor: c.surfaceAlt,
    borderRadius: radii.md,
  },
  segmentBtn: {
    flex: 1,
    alignItems: "center",
    paddingVertical: 7,
    borderRadius: radii.sm,
  },
  segmentBtnOn: { backgroundColor: c.surface },
  segmentText: { color: c.textMuted, fontSize: 14, fontWeight: "600" },
  segmentTextOn: { color: c.text, fontWeight: "700" },
  weekNav: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingHorizontal: 24,
    paddingVertical: 6,
  },
  navArrow: { color: c.accent, fontSize: 30, fontWeight: "700", width: 32, textAlign: "center" },
  weekLabel: { color: c.text, fontSize: 16, fontWeight: "700", textAlign: "center" },
  todayLink: { color: c.accent, fontSize: 12, textAlign: "center", marginTop: 1 },
  center: { flex: 1, alignItems: "center", justifyContent: "center" },
  body: { paddingHorizontal: 24, paddingBottom: 24, paddingTop: 6 },
  daySection: { marginTop: 14 },
  dayLabel: {
    color: c.textMuted,
    fontSize: 13,
    fontWeight: "700",
    letterSpacing: 1,
    textTransform: "uppercase",
    marginBottom: 6,
  },
  none: { color: c.textMuted, fontSize: 14, paddingVertical: 4 },
  shift: {
    flexDirection: "row",
    alignItems: "center",
    backgroundColor: c.surface,
    borderColor: c.border,
    borderWidth: 1,
    borderRadius: radii.md,
    paddingVertical: 12,
    paddingHorizontal: 14,
    marginBottom: 8,
  },
  shiftText: { flex: 1 },
  who: { color: c.text, fontSize: 16, fontWeight: "600" },
  badge: { color: c.textMuted, fontSize: 14 },
  when: { color: c.textMuted, fontSize: 13, marginTop: 2 },
  remove: { color: c.textMuted, fontSize: 16, marginLeft: 10 },
  bannerWrap: {
    backgroundColor: c.success,
    paddingVertical: 12,
    paddingHorizontal: 20,
  },
  bannerText: { color: c.accentText, fontSize: 14, textAlign: "center" },
});
