import { useCallback, useState } from "react";
import {
  ActivityIndicator,
  RefreshControl,
  ScrollView,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { useFocusEffect } from "@react-navigation/native";

import {
  decidePayroll,
  getManagerPending,
  reviewEntryEditRequest,
  reviewLeave,
  type EditRequestDto,
  type PendingLeave,
  type PendingTimesheet,
} from "../api";
import { EditEntryModal } from "../components/EditEntryModal";
import { haptics } from "../lib/haptics";
import { getAccessToken } from "../supabase";
import { lightColors as c } from "../theme";

const MONTHS = [
  "Jan", "Feb", "Mar", "Apr", "May", "Jun",
  "Jul", "Aug", "Sep", "Oct", "Nov", "Dec",
];

function clock(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "—:—";
  let h = d.getHours();
  const m = d.getMinutes();
  const ampm = h >= 12 ? "PM" : "AM";
  h = h % 12 || 12;
  return `${h}:${m.toString().padStart(2, "0")} ${ampm}`;
}

function dateShort(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "—";
  return `${MONTHS[d.getMonth()]} ${d.getDate()}`;
}

function ymd(s: string): string {
  const [y, mo, d] = s.split("-").map(Number);
  if (!y || !mo || !d || mo < 1 || mo > 12) return s;
  return `${MONTHS[mo - 1]} ${d}`;
}

function dur(ms: number): string {
  const min = Math.floor((ms > 0 ? ms : 0) / 60000);
  const h = Math.floor(min / 60);
  const m = min % 60;
  return h > 0 ? `${h}h ${m}m` : `${m}m`;
}

export function ApprovalsScreen() {
  const [timesheets, setTimesheets] = useState<PendingTimesheet[]>([]);
  const [leave, setLeave] = useState<PendingLeave[]>([]);
  const [editRequests, setEditRequests] = useState<EditRequestDto[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [banner, setBanner] = useState<string | null>(null);
  const [editEntry, setEditEntry] = useState<PendingTimesheet | null>(null);

  const load = useCallback(async () => {
    const token = await getAccessToken();
    if (!token) {
      setLoading(false);
      setRefreshing(false);
      return;
    }
    try {
      const res = await getManagerPending(token);
      if (res.ok) {
        setTimesheets(res.data.timesheets);
        setLeave(res.data.leave);
        setEditRequests(res.data.editRequests);
      }
    } catch {
      // keep last-known queue on a network blip
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, []);

  // Refetch every time the Approvals tab regains focus, so new requests and
  // approvals from elsewhere show up without reopening the app.
  useFocusEffect(
    useCallback(() => {
      void load();
    }, [load]),
  );

  const onRefresh = useCallback(() => {
    setRefreshing(true);
    void load();
  }, [load]);

  const decideTimesheets = useCallback(
    async (ids: string[], action: "approve" | "reject") => {
      if (ids.length === 0) return;
      haptics[action === "approve" ? "success" : "warning"]();
      const token = await getAccessToken();
      if (!token) return;
      setBanner(null);
      const prev = timesheets;
      setTimesheets((ts) => ts.filter((t) => !ids.includes(t.id)));
      try {
        const res = await decidePayroll(token, action, ids);
        if (!res.ok) {
          setTimesheets(prev);
          setBanner(`Couldn't ${action} — try again.`);
        }
      } catch {
        setTimesheets(prev);
        setBanner("No connection — try again.");
      }
    },
    [timesheets],
  );

  const decideLeave = useCallback(
    async (id: string, decision: "approved" | "rejected") => {
      haptics[decision === "approved" ? "success" : "warning"]();
      const token = await getAccessToken();
      if (!token) return;
      setBanner(null);
      const prev = leave;
      setLeave((l) => l.filter((x) => x.id !== id));
      try {
        const res = await reviewLeave(token, id, decision);
        // 409 = already handled (treat as done, keep it removed).
        if (!res.ok && res.status !== 409) {
          setLeave(prev);
          setBanner("Couldn't update — try again.");
        }
      } catch {
        setLeave(prev);
        setBanner("No connection — try again.");
      }
    },
    [leave],
  );

  const decideEditRequest = useCallback(
    async (id: string, decision: "approved" | "rejected") => {
      haptics[decision === "approved" ? "success" : "warning"]();
      const token = await getAccessToken();
      if (!token) return;
      setBanner(null);
      const prev = editRequests;
      setEditRequests((r) => r.filter((x) => x.id !== id));
      try {
        const res = await reviewEntryEditRequest(token, id, decision);
        if (!res.ok) {
          setEditRequests(prev);
          setBanner(
            res.status === 409
              ? "That shift is approved and locked. Unlock it on the web first."
              : "Couldn't update — try again.",
          );
        } else {
          // Reload after any decision: approve applies + approves the shift,
          // reject returns it to the timesheet queue (it was shadow-hidden
          // while the request was pending). Both need a refetch to show right.
          void load();
        }
      } catch {
        setEditRequests(prev);
        setBanner("No connection — try again.");
      }
    },
    [editRequests, load],
  );

  if (loading) {
    return (
      <SafeAreaView style={[styles.container, styles.center]} edges={["top"]}>
        <ActivityIndicator color={c.accent} size="large" />
      </SafeAreaView>
    );
  }

  const empty =
    timesheets.length === 0 &&
    leave.length === 0 &&
    editRequests.length === 0;

  return (
    <SafeAreaView style={styles.container} edges={["top"]}>
      <View style={styles.header}>
        <Text style={styles.title}>Approvals</Text>
      </View>

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
        {empty ? (
          <>
            <Text style={styles.allClear}>All caught up. Nothing pending.</Text>
            <Text style={styles.allClearHint}>
              Timesheets, time-off, and shift-change requests from your team
              land here for you to approve or reject. There is nothing to review
              right now.
            </Text>
          </>
        ) : null}

        {timesheets.length > 0 ? (
          <View style={styles.section}>
            <View style={styles.sectionHead}>
              <Text style={styles.sectionTitle}>
                Timesheets ({timesheets.length})
              </Text>
              <TouchableOpacity
                onPress={() =>
                  decideTimesheets(
                    timesheets.map((t) => t.id),
                    "approve",
                  )
                }
                hitSlop={8}
              >
                <Text style={styles.approveAll}>Approve all</Text>
              </TouchableOpacity>
            </View>
            {timesheets.map((t) => (
              <View key={t.id} style={styles.card}>
                <Text style={styles.who} numberOfLines={1}>
                  {t.employee}
                  {t.source !== "timer" && t.source !== "mobile" ? (
                    <Text style={styles.badge}>  from {t.source}</Text>
                  ) : null}
                </Text>
                <Text style={styles.meta} numberOfLines={1}>
                  {dateShort(t.start)} · {clock(t.start)}–{clock(t.end)} ·{" "}
                  {dur(t.durationMs)}
                  {t.project ? ` · ${t.project}` : ""}
                </Text>
                <View style={styles.tsActions}>
                  <TouchableOpacity onPress={() => setEditEntry(t)} hitSlop={8}>
                    <Text style={styles.editText}>Edit</Text>
                  </TouchableOpacity>
                  <View style={styles.actionsRight}>
                    <TouchableOpacity
                      style={[styles.btn, styles.reject]}
                      onPress={() => decideTimesheets([t.id], "reject")}
                    >
                      <Text style={styles.rejectText}>Reject</Text>
                    </TouchableOpacity>
                    <TouchableOpacity
                      style={[styles.btn, styles.approve]}
                      onPress={() => decideTimesheets([t.id], "approve")}
                    >
                      <Text style={styles.approveText}>Approve</Text>
                    </TouchableOpacity>
                  </View>
                </View>
              </View>
            ))}
          </View>
        ) : null}

        {leave.length > 0 ? (
          <View style={styles.section}>
            <Text style={styles.sectionTitle}>Time off ({leave.length})</Text>
            {leave.map((l) => (
              <View key={l.id} style={styles.card}>
                <Text style={styles.who} numberOfLines={1}>
                  {l.employee}
                </Text>
                <Text style={styles.meta} numberOfLines={1}>
                  {l.kind} · {ymd(l.startsOn)}
                  {l.endsOn !== l.startsOn ? `–${ymd(l.endsOn)}` : ""}
                </Text>
                {l.notes ? (
                  <Text style={styles.notes} numberOfLines={3}>
                    {l.notes}
                  </Text>
                ) : null}
                <View style={styles.actions}>
                  <TouchableOpacity
                    style={[styles.btn, styles.reject]}
                    onPress={() => decideLeave(l.id, "rejected")}
                  >
                    <Text style={styles.rejectText}>Reject</Text>
                  </TouchableOpacity>
                  <TouchableOpacity
                    style={[styles.btn, styles.approve]}
                    onPress={() => decideLeave(l.id, "approved")}
                  >
                    <Text style={styles.approveText}>Approve</Text>
                  </TouchableOpacity>
                </View>
              </View>
            ))}
          </View>
        ) : null}

        {editRequests.length > 0 ? (
          <View style={styles.section}>
            <Text style={styles.sectionTitle}>
              Edit requests ({editRequests.length})
            </Text>
            {editRequests.map((r) => (
              <View key={r.id} style={styles.card}>
                <Text style={styles.who} numberOfLines={1}>
                  {r.employee}
                </Text>
                <Text style={styles.meta} numberOfLines={1}>
                  {dateShort(r.originalStart)} · was {clock(r.originalStart)}–
                  {clock(r.originalEnd)}
                </Text>
                <Text style={styles.reqNew} numberOfLines={1}>
                  Requested: {clock(r.requestedStart)}–{clock(r.requestedEnd)}
                  {r.project ? ` · ${r.project}` : ""}
                </Text>
                {r.reason ? (
                  <Text style={styles.notes} numberOfLines={3}>
                    {r.reason}
                  </Text>
                ) : null}
                <View style={styles.actions}>
                  <TouchableOpacity
                    style={[styles.btn, styles.reject]}
                    onPress={() => decideEditRequest(r.id, "rejected")}
                  >
                    <Text style={styles.rejectText}>Reject</Text>
                  </TouchableOpacity>
                  <TouchableOpacity
                    style={[styles.btn, styles.approve]}
                    onPress={() => decideEditRequest(r.id, "approved")}
                  >
                    <Text style={styles.approveText}>Approve</Text>
                  </TouchableOpacity>
                </View>
              </View>
            ))}
          </View>
        ) : null}
      </ScrollView>

      <EditEntryModal
        visible={editEntry !== null}
        entry={editEntry}
        onClose={() => setEditEntry(null)}
        onSaved={() => {
          setEditEntry(null);
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
  center: { alignItems: "center", justifyContent: "center" },
  header: { paddingHorizontal: 24, paddingTop: 12, paddingBottom: 8 },
  title: { color: c.text, fontSize: 28, fontWeight: "800" },
  body: { paddingHorizontal: 24, paddingBottom: 24 },
  allClear: {
    color: c.textMuted,
    fontSize: 16,
    textAlign: "center",
    marginTop: 48,
  },
  allClearHint: {
    color: c.textMuted,
    fontSize: 14,
    textAlign: "center",
    lineHeight: 20,
    marginTop: 10,
    paddingHorizontal: 16,
  },
  section: { marginTop: 16 },
  sectionHead: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    marginBottom: 8,
  },
  sectionTitle: {
    color: c.textMuted,
    fontSize: 13,
    fontWeight: "700",
    letterSpacing: 1,
    textTransform: "uppercase",
    marginBottom: 8,
  },
  approveAll: { color: c.accent, fontSize: 14, fontWeight: "700" },
  card: {
    backgroundColor: c.surface,
    borderColor: c.border,
    borderWidth: 1,
    borderRadius: 14,
    padding: 14,
    marginBottom: 10,
  },
  who: { color: c.text, fontSize: 16, fontWeight: "700" },
  badge: { color: c.textMuted, fontSize: 12, fontWeight: "600" },
  meta: { color: c.textMuted, fontSize: 13, marginTop: 3 },
  reqNew: { color: c.text, fontSize: 13, fontWeight: "600", marginTop: 3 },
  notes: { color: c.text, fontSize: 13, marginTop: 6, lineHeight: 18 },
  actions: { flexDirection: "row", justifyContent: "flex-end", marginTop: 12 },
  tsActions: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    marginTop: 12,
  },
  actionsRight: { flexDirection: "row" },
  editText: { color: c.accent, fontSize: 15, fontWeight: "700" },
  btn: {
    borderRadius: 10,
    paddingVertical: 9,
    paddingHorizontal: 18,
    marginLeft: 10,
  },
  reject: { backgroundColor: c.surfaceAlt, borderWidth: 1, borderColor: c.border },
  rejectText: { color: c.danger, fontSize: 15, fontWeight: "700" },
  approve: { backgroundColor: c.accent },
  approveText: { color: c.accentText, fontSize: 15, fontWeight: "700" },
  bannerWrap: {
    backgroundColor: c.danger,
    paddingVertical: 12,
    paddingHorizontal: 20,
  },
  bannerText: { color: "#fff", fontSize: 14, textAlign: "center" },
});
