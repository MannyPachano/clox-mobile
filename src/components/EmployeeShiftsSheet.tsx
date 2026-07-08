import { useCallback, useEffect, useState } from "react";
import {
  ActivityIndicator,
  Alert,
  Modal,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from "react-native";

import {
  getManagerEntries,
  type EditableEntry,
  type ManagerEntry,
} from "../api";
import { getAccessToken } from "../supabase";
import { lightColors as c } from "../theme";
import { EditEntryModal } from "./EditEntryModal";

const DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const MONTHS = [
  "Jan", "Feb", "Mar", "Apr", "May", "Jun",
  "Jul", "Aug", "Sep", "Oct", "Nov", "Dec",
];
const DAY_MS = 86_400_000;

function pad(n: number): string {
  return n.toString().padStart(2, "0");
}

function fmtDate(iso: string): string {
  const d = new Date(iso);
  return `${DAYS[d.getDay()]}, ${MONTHS[d.getMonth()]} ${d.getDate()}`;
}

function clock(iso: string): string {
  const d = new Date(iso);
  let h = d.getHours();
  const m = d.getMinutes();
  const ap = h >= 12 ? "PM" : "AM";
  h = h % 12 || 12;
  return `${h}:${pad(m)} ${ap}`;
}

function dur(ms: number): string {
  const min = Math.floor((ms > 0 ? ms : 0) / 60000);
  const h = Math.floor(min / 60);
  const m = min % 60;
  return h > 0 ? `${h}h ${m}m` : `${m}m`;
}

type Props = {
  visible: boolean;
  employee: { userId: string; name: string } | null;
  onClose: () => void;
};

/**
 * A manager browses one person's recent clocked shifts (last 30 days) and taps
 * one to edit it via EditEntryModal. Works for the manager's own shifts too
 * (tap yourself in the roster). Approved/locked shifts are read-only here — they
 * must be unlocked on the web first.
 */
export function EmployeeShiftsSheet({ visible, employee, onClose }: Props) {
  const [entries, setEntries] = useState<ManagerEntry[]>([]);
  const [loading, setLoading] = useState(false);
  const [editEntry, setEditEntry] = useState<EditableEntry | null>(null);

  const load = useCallback(async () => {
    if (!employee) return;
    const token = await getAccessToken();
    if (!token) return;
    setLoading(true);
    const now = Date.now();
    const fromIso = new Date(now - 30 * DAY_MS).toISOString();
    const toIso = new Date(now + DAY_MS).toISOString();
    try {
      const res = await getManagerEntries(
        token,
        employee.userId,
        fromIso,
        toIso,
      );
      if (res.ok) setEntries(res.data.entries);
    } catch {
      // keep last-known list on a network blip
    } finally {
      setLoading(false);
    }
  }, [employee]);

  useEffect(() => {
    if (visible && employee) {
      setEntries([]);
      void load();
    }
  }, [visible, employee, load]);

  const onRowPress = useCallback(
    (e: ManagerEntry) => {
      if (e.locked || e.approved) {
        Alert.alert(
          "Approved shift",
          "This shift is approved and locked. Unlock it on the web to edit.",
        );
        return;
      }
      setEditEntry({
        id: e.id,
        employee: employee?.name,
        start: e.start,
        end: e.end,
        projectId: e.projectId,
        note: e.note,
      });
    },
    [employee],
  );

  return (
    <Modal
      visible={visible}
      transparent
      animationType="slide"
      onRequestClose={onClose}
    >
      <Pressable style={styles.backdrop} onPress={onClose}>
        <Pressable style={styles.sheet} onPress={() => {}}>
          <Text style={styles.title}>{employee?.name ?? "Shifts"}</Text>
          <Text style={styles.subtitle}>
            Last 30 days. Tap a shift to edit it.
          </Text>
          {loading ? (
            <View style={styles.center}>
              <ActivityIndicator color={c.accent} size="large" />
            </View>
          ) : entries.length === 0 ? (
            <Text style={styles.empty}>
              No clocked shifts in the last 30 days.
            </Text>
          ) : (
            <ScrollView style={styles.scroll}>
              {entries.map((e) => (
                <TouchableOpacity
                  key={e.id}
                  style={styles.row}
                  activeOpacity={0.6}
                  onPress={() => onRowPress(e)}
                >
                  <View style={styles.rowText}>
                    <Text style={styles.date}>{fmtDate(e.start)}</Text>
                    <Text style={styles.times} numberOfLines={1}>
                      {clock(e.start)} – {clock(e.end)} · {dur(e.durationMs)}
                      {e.project ? ` · ${e.project}` : ""}
                    </Text>
                  </View>
                  {e.locked || e.approved ? (
                    <Text style={styles.tag}>Approved</Text>
                  ) : (
                    <Text style={styles.chev}>›</Text>
                  )}
                </TouchableOpacity>
              ))}
            </ScrollView>
          )}
          <View style={styles.actions}>
            <TouchableOpacity onPress={onClose} hitSlop={8}>
              <Text style={styles.done}>Done</Text>
            </TouchableOpacity>
          </View>

          {/* Nested inside the sheet (not a sibling) so it presents on the
              sheet's own view controller — a sibling modal collides on iOS. */}
          <EditEntryModal
            visible={editEntry != null}
            entry={editEntry}
            onClose={() => setEditEntry(null)}
            onSaved={() => {
              setEditEntry(null);
              void load();
            }}
          />
        </Pressable>
      </Pressable>
    </Modal>
  );
}

const styles = StyleSheet.create({
  backdrop: {
    flex: 1,
    backgroundColor: "rgba(0,0,0,0.6)",
    justifyContent: "flex-end",
  },
  sheet: {
    backgroundColor: c.bg,
    borderTopLeftRadius: 20,
    borderTopRightRadius: 20,
    paddingTop: 18,
    paddingBottom: 24,
    maxHeight: "88%",
  },
  title: {
    color: c.text,
    fontSize: 20,
    fontWeight: "800",
    paddingHorizontal: 20,
  },
  subtitle: {
    color: c.textMuted,
    fontSize: 14,
    paddingHorizontal: 20,
    marginTop: 2,
    marginBottom: 8,
  },
  scroll: { paddingHorizontal: 20 },
  center: { paddingVertical: 40, alignItems: "center" },
  empty: {
    color: c.textMuted,
    fontSize: 15,
    paddingHorizontal: 20,
    paddingVertical: 28,
    textAlign: "center",
  },
  row: {
    flexDirection: "row",
    alignItems: "center",
    paddingVertical: 14,
    borderTopWidth: 1,
    borderTopColor: c.border,
  },
  rowText: { flex: 1 },
  date: { color: c.text, fontSize: 16, fontWeight: "600" },
  times: { color: c.textMuted, fontSize: 13, marginTop: 2 },
  tag: { color: c.textMuted, fontSize: 13, fontWeight: "600", marginLeft: 8 },
  chev: { color: c.textMuted, fontSize: 22, marginLeft: 8 },
  actions: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "flex-end",
    paddingHorizontal: 20,
    paddingTop: 12,
  },
  done: { color: c.accent, fontSize: 16, fontWeight: "700" },
});
