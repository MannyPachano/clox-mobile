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

function dayKey(d: Date): string {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
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

/** Monday of the week `offset` weeks from now, at local midnight. */
function mondayOf(offset: number): Date {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  const day = d.getDay(); // 0 = Sun
  const diffToMonday = day === 0 ? -6 : 1 - day;
  d.setDate(d.getDate() + diffToMonday + offset * 7);
  return d;
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
  const [selectedDayKey, setSelectedDayKey] = useState(() => dayKey(new Date()));
  const [isOffline, setIsOffline] = useState(false);

  const todayKey = useMemo(() => dayKey(new Date()), []);

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

  const weekStart = useMemo(() => mondayOf(weekOffset), [weekOffset]);

  const range = useMemo(() => {
    const end = new Date(weekStart);
    end.setDate(weekStart.getDate() + 7);
    return { fromIso: weekStart.toISOString(), toIso: end.toISOString() };
  }, [weekStart]);

  const days = useMemo(() => {
    const out: { key: string; label: string }[] = [];
    for (let i = 0; i < 7; i++) {
      const d = new Date(weekStart);
      d.setDate(weekStart.getDate() + i);
      out.push({
        key: dayKey(d),
        label: `${DOW[d.getDay()]} · ${MONTHS[d.getMonth()]} ${d.getDate()}`,
      });
    }
    return out;
  }, [weekStart]);

  const weekLabel = useMemo(() => {
    const end = new Date(weekStart);
    end.setDate(weekStart.getDate() + 6);
    const a = `${MONTHS[weekStart.getMonth()]} ${weekStart.getDate()}`;
    const b =
      end.getMonth() === weekStart.getMonth()
        ? `${end.getDate()}`
        : `${MONTHS[end.getMonth()]} ${end.getDate()}`;
    return `${a} to ${b}`;
  }, [weekStart]);

  const byDay = useMemo(() => {
    const m = new Map<string, ScheduledShiftDto[]>();
    for (const s of shifts) {
      const k = dayKey(new Date(s.startsAt));
      const list = m.get(k);
      if (list) list.push(s);
      else m.set(k, [s]);
    }
    return m;
  }, [shifts]);

  const dayKeys = useMemo(() => days.map((d) => d.key), [days]);

  // The board's selected day, clamped to the visible week: derived (not stored
  // via an effect) so navigating weeks falls back to today / the week's first
  // day without a cascading setState.
  const effectiveDayKey = dayKeys.includes(selectedDayKey)
    ? selectedDayKey
    : dayKeys.includes(todayKey)
      ? todayKey
      : (dayKeys[0] ?? todayKey);

  // Move a shift to another day, keeping its wall-clock time and duration.
  // Optimistic: the card jumps immediately and rolls back if the save fails.
  const moveShiftToDay = useCallback(
    async (shift: ScheduledShiftDto, targetKey: string) => {
      const token = await getAccessToken();
      if (!token) return;
      const start = new Date(shift.startsAt);
      const durationMs = new Date(shift.endsAt).getTime() - start.getTime();
      const [ty, tm, td] = targetKey.split("-").map(Number);
      const newStart = new Date(
        ty ?? 1970,
        (tm ?? 1) - 1,
        td ?? 1,
        start.getHours(),
        start.getMinutes(),
        0,
        0,
      );
      const startIso = newStart.toISOString();
      const endIso = new Date(newStart.getTime() + durationMs).toISOString();

      // Roll back by shift id (not a whole-array snapshot) so a concurrent
      // refetch/add/delete during the in-flight save isn't clobbered. Restore
      // the day the user was viewing (the shift's source day) so a failed move
      // doesn't strand them on the now-empty target day.
      const sourceKey = dayKey(start);
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
