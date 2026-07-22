import { useCallback, useEffect, useMemo, useState } from "react";
import {
  ActivityIndicator,
  Alert,
  FlatList,
  RefreshControl,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { useFocusEffect } from "@react-navigation/native";
import AsyncStorage from "@react-native-async-storage/async-storage";

import {
  closeShift,
  getManagerRoster,
  type EditableEntry,
  type ManagerRosterEntry,
} from "../api";
import { AddEntryModal } from "../components/AddEntryModal";
import { EditEntryModal } from "../components/EditEntryModal";
import { EmployeeShiftsSheet } from "../components/EmployeeShiftsSheet";
import { RosterMap } from "../components/RosterMap";
import { getAccessToken } from "../supabase";
import { lightColors as c, radii } from "../theme";

type ViewMode = "list" | "map";
const MODE_KEY = "clox.roster.viewmode.v1";

// Manager screens use the light "paper" theme (the dark on-shift palette is for
// an employee's own running clock).

function clock(ms: number): string {
  const d = new Date(ms);
  let h = d.getHours();
  const m = d.getMinutes();
  const ampm = h >= 12 ? "PM" : "AM";
  h = h % 12 || 12;
  return `${h}:${m.toString().padStart(2, "0")} ${ampm}`;
}

function dur(ms: number): string {
  const min = Math.floor((ms > 0 ? ms : 0) / 60000);
  const h = Math.floor(min / 60);
  const m = min % 60;
  return h > 0 ? `${h}h ${m}m` : `${m}m`;
}

/** Cents → "$1,234.56" without Intl (Hermes support is spotty). */
function money(cents: number): string {
  const [whole, frac] = (Math.round(cents) / 100).toFixed(2).split(".");
  return `$${whole.replace(/\B(?=(\d{3})+(?!\d))/g, ",")}.${frac}`;
}

function hoursLabel(ms: number): string {
  return (Math.max(0, ms) / 3_600_000).toFixed(1);
}

export function RosterScreen() {
  const [roster, setRoster] = useState<ManagerRosterEntry[]>([]);
  const [onShiftCount, setOnShiftCount] = useState(0);
  const [labor, setLabor] = useState<{
    cents: number;
    workedMs: number;
    hasRates: boolean;
  } | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [now, setNow] = useState(() => Date.now());
  const [addOpen, setAddOpen] = useState(false);
  const [shiftsFor, setShiftsFor] = useState<{
    userId: string;
    name: string;
  } | null>(null);
  // A team member's RUNNING entry, for the start-only editor.
  const [adjustFor, setAdjustFor] = useState<{
    entryId: string;
    startIso: string;
    name: string;
  } | null>(null);
  const [banner, setBanner] = useState<string | null>(null);
  const [mode, setMode] = useState<ViewMode>("list");

  // Restore the last-used List/Map view.
  useEffect(() => {
    AsyncStorage.getItem(MODE_KEY)
      .then((v) => {
        if (v === "map" || v === "list") setMode(v);
      })
      .catch(() => {});
  }, []);

  const changeMode = useCallback((m: ViewMode) => {
    setMode(m);
    AsyncStorage.setItem(MODE_KEY, m).catch(() => {});
  }, []);

  // Stable entry object for EditEntryModal (a fresh literal each render would
  // re-fire its prefill effect on every roster tick).
  const adjustEntry = useMemo<EditableEntry | null>(
    () =>
      adjustFor
        ? {
            id: adjustFor.entryId,
            employee: adjustFor.name,
            start: adjustFor.startIso,
            projectId: null,
            note: null,
          }
        : null,
    [adjustFor],
  );

  const load = useCallback(async () => {
    const token = await getAccessToken();
    if (!token) {
      setLoading(false);
      setRefreshing(false);
      return;
    }
    try {
      const res = await getManagerRoster(token);
      if (res.ok) {
        setRoster(res.data.roster);
        setOnShiftCount(res.data.onShiftCount);
        setLabor({
          cents: res.data.todayLaborCents,
          workedMs: res.data.todayWorkedMs,
          hasRates: res.data.todayHasRates,
        });
      }
    } catch {
      // keep last-known roster on a network blip
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, []);

  useFocusEffect(
    useCallback(() => {
      void load();
    }, [load]),
  );

  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 30000);
    return () => clearInterval(id);
  }, []);

  const onRefresh = useCallback(() => {
    setRefreshing(true);
    void load();
  }, [load]);

  const doClose = useCallback(
    async (item: ManagerRosterEntry) => {
      const token = await getAccessToken();
      if (!token) return;
      try {
        const res = await closeShift(token, item.userId);
        if (res.ok) {
          setBanner(`Clocked out ${item.name}.`);
          void load();
        } else if (res.error === "project_required") {
          Alert.alert(
            "Can't clock out here",
            "This org requires a project at clock-out. Close this shift on the web.",
          );
        } else {
          setBanner("Couldn't clock them out. Try again.");
        }
      } catch {
        setBanner("No connection. Try again.");
      }
    },
    [load],
  );

  const confirmClose = useCallback(
    (item: ManagerRosterEntry) => {
      if (!item.onShift) return;
      Alert.alert(
        `Clock out ${item.name}?`,
        "This closes their running shift now. You can fix the exact time in Approvals.",
        [
          { text: "Cancel", style: "cancel" },
          {
            text: "Clock out",
            style: "destructive",
            onPress: () => void doClose(item),
          },
        ],
      );
    },
    [doClose],
  );

  const sorted = [...roster].sort(
    (a, b) => Number(b.onShift) - Number(a.onShift),
  );

  const renderItem = ({ item }: { item: ManagerRosterEntry }) => {
    const since = item.shiftStartedAt ? Date.parse(item.shiftStartedAt) : null;
    const activeEntryId = item.activeEntryId ?? null;
    const activeStartIso = item.activeStartIso ?? null;
    return (
      <View style={styles.row}>
        <TouchableOpacity
          style={styles.rowMain}
          activeOpacity={0.6}
          onPress={() => setShiftsFor({ userId: item.userId, name: item.name })}
        >
          <View
            style={[styles.dot, item.onShift ? styles.dotOn : styles.dotOff]}
          />
          <View style={styles.rowText}>
            <Text style={styles.name} numberOfLines={1}>
              {item.name}
              {item.role === "manager" ? (
                <Text style={styles.badge}>  manager</Text>
              ) : null}
            </Text>
            {item.onShift && since ? (
              <Text style={styles.sub} numberOfLines={1}>
                On since {clock(since)} · {dur(now - since)}
                {item.project ? ` · ${item.project}` : ""}
              </Text>
            ) : (
              <Text style={styles.subOff}>Off the clock</Text>
            )}
          </View>
        </TouchableOpacity>
        {item.onShift ? (
          <>
            {activeEntryId && activeStartIso ? (
              <TouchableOpacity
                style={styles.clockOutBtn}
                activeOpacity={0.8}
                onPress={() =>
                  setAdjustFor({
                    entryId: activeEntryId,
                    startIso: activeStartIso,
                    name: item.name,
                  })
                }
              >
                <Text style={styles.clockOutText}>Adjust start</Text>
              </TouchableOpacity>
            ) : null}
            <TouchableOpacity
              style={styles.clockOutBtn}
              activeOpacity={0.8}
              onPress={() => confirmClose(item)}
            >
              <Text style={styles.clockOutText}>Clock out</Text>
            </TouchableOpacity>
          </>
        ) : (
          <Text style={styles.chev}>›</Text>
        )}
      </View>
    );
  };

  return (
    <SafeAreaView style={styles.container} edges={["top"]}>
      <View style={styles.header}>
        <View style={styles.headerText}>
          <Text style={styles.title}>Roster</Text>
          <Text style={styles.count}>{onShiftCount} on the clock now</Text>
          {labor && labor.workedMs > 0 ? (
            <Text style={styles.labor}>
              {hoursLabel(labor.workedMs)}h today
              {labor.hasRates ? ` · ${money(labor.cents)} labor` : ""}
            </Text>
          ) : null}
        </View>
        <TouchableOpacity
          style={styles.addBtn}
          onPress={() => setAddOpen(true)}
          activeOpacity={0.85}
        >
          <Text style={styles.addBtnText}>+ Add entry</Text>
        </TouchableOpacity>
      </View>

      <View style={styles.segment}>
        {(["list", "map"] as const).map((m) => (
          <TouchableOpacity
            key={m}
            style={[styles.segmentBtn, mode === m && styles.segmentBtnOn]}
            onPress={() => changeMode(m)}
            activeOpacity={0.85}
            accessibilityRole="button"
            accessibilityState={{ selected: mode === m }}
          >
            <Text style={[styles.segmentText, mode === m && styles.segmentTextOn]}>
              {m === "list" ? "List" : "Map"}
            </Text>
          </TouchableOpacity>
        ))}
      </View>

      {mode === "map" ? (
        <RosterMap />
      ) : loading ? (
        <View style={styles.center}>
          <ActivityIndicator color={c.accent} size="large" />
        </View>
      ) : (
        <FlatList
          data={sorted}
          keyExtractor={(item) => item.userId}
          renderItem={renderItem}
          contentContainerStyle={styles.list}
          refreshControl={
            <RefreshControl
              refreshing={refreshing}
              onRefresh={onRefresh}
              tintColor={c.accent}
            />
          }
          ListHeaderComponent={
            sorted.length > 0 ? (
              <Text style={styles.hint}>
                Tap a name to view and edit their shifts. Use Adjust start to
                fix when a running shift began, or Clock out to close it.
              </Text>
            ) : null
          }
          ListEmptyComponent={
            <Text style={styles.empty}>
              No team members yet. Invite your crew from the Clox website. Once
              they sign in here, they show up on this roster.
            </Text>
          }
        />
      )}

      <AddEntryModal
        visible={addOpen}
        employees={roster.map((r) => ({ id: r.userId, name: r.name }))}
        onClose={() => setAddOpen(false)}
        onCreated={() => {
          setAddOpen(false);
          setBanner("Entry added — it's now pending your approval.");
        }}
      />

      <EmployeeShiftsSheet
        visible={shiftsFor != null}
        employee={shiftsFor}
        onClose={() => setShiftsFor(null)}
      />

      <EditEntryModal
        visible={adjustFor != null}
        entry={adjustEntry}
        startOnly
        onClose={() => setAdjustFor(null)}
        onSaved={() => {
          setAdjustFor(null);
          setBanner("Start time updated.");
          void load();
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
  headerText: { flex: 1 },
  title: { color: c.text, fontSize: 28, fontWeight: "800" },
  count: { color: c.textMuted, fontSize: 15, marginTop: 2 },
  labor: { color: c.text, fontSize: 14, fontWeight: "600", marginTop: 2 },
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
    marginBottom: 4,
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
  center: { flex: 1, alignItems: "center", justifyContent: "center" },
  list: { paddingHorizontal: 24, paddingBottom: 24 },
  row: {
    flexDirection: "row",
    alignItems: "center",
    paddingVertical: 14,
    borderTopWidth: 1,
    borderTopColor: c.border,
  },
  dot: { width: 10, height: 10, borderRadius: 5, marginRight: 14 },
  dotOn: { backgroundColor: c.success },
  dotOff: { backgroundColor: c.border },
  rowMain: { flex: 1, flexDirection: "row", alignItems: "center" },
  rowText: { flex: 1 },
  name: { color: c.text, fontSize: 16, fontWeight: "600" },
  badge: { color: c.textMuted, fontSize: 13, fontWeight: "600" },
  sub: { color: c.text, fontSize: 13, marginTop: 2 },
  subOff: { color: c.textMuted, fontSize: 13, marginTop: 2 },
  chev: { color: c.textMuted, fontSize: 22, marginLeft: 8 },
  clockOutBtn: {
    borderWidth: 1,
    borderColor: c.border,
    borderRadius: 10,
    paddingVertical: 6,
    paddingHorizontal: 12,
    marginLeft: 8,
  },
  clockOutText: { color: c.text, fontSize: 13, fontWeight: "600" },
  hint: {
    color: c.textMuted,
    fontSize: 13,
    marginBottom: 4,
  },
  empty: {
    color: c.textMuted,
    fontSize: 15,
    textAlign: "center",
    marginTop: 40,
  },
  bannerWrap: {
    backgroundColor: c.success,
    paddingVertical: 12,
    paddingHorizontal: 20,
  },
  bannerText: { color: c.accentText, fontSize: 14, textAlign: "center" },
});
