import { useEffect, useMemo, useState } from "react";
import {
  ActivityIndicator,
  Modal,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from "react-native";

import { createManagerEntry, getStatus, type Option } from "../api";
import { getAccessToken } from "../supabase";
import { lightColors as c, scrim } from "../theme";
import { hhmmEndsNextDay } from "../lib/edit-time";
import { SelectField } from "./SelectField";

const DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const MONTHS = [
  "Jan", "Feb", "Mar", "Apr", "May", "Jun",
  "Jul", "Aug", "Sep", "Oct", "Nov", "Dec",
];

function pad(n: number): string {
  return n.toString().padStart(2, "0");
}

/** Last 14 days as options, id = "YYYY-MM-DD" (local). */
function buildDays(): Option[] {
  const base = new Date();
  base.setHours(0, 0, 0, 0);
  const out: Option[] = [];
  for (let i = 0; i < 14; i++) {
    const d = new Date(base.getTime() - i * 86_400_000);
    const id = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
    const name =
      i === 0
        ? "Today"
        : i === 1
          ? "Yesterday"
          : `${DAYS[d.getDay()]}, ${MONTHS[d.getMonth()]} ${d.getDate()}`;
    out.push({ id, name });
  }
  return out;
}

/** Times in 15-min steps, id = "HH:MM" (24h), name = "9:00 AM". */
function buildTimes(): Option[] {
  const out: Option[] = [];
  for (let h = 0; h < 24; h++) {
    for (const m of [0, 15, 30, 45]) {
      const hh = h % 12 || 12;
      const ap = h >= 12 ? "PM" : "AM";
      out.push({ id: `${pad(h)}:${pad(m)}`, name: `${hh}:${pad(m)} ${ap}` });
    }
  }
  return out;
}

function toIso(dateId: string, timeId: string): string | null {
  const [y, mo, d] = dateId.split("-").map(Number);
  const [h, mi] = timeId.split(":").map(Number);
  if (!y || !mo || !d || Number.isNaN(h) || Number.isNaN(mi)) return null;
  const dt = new Date(y, mo - 1, d, h, mi, 0, 0);
  return Number.isNaN(dt.getTime()) ? null : dt.toISOString();
}

type Props = {
  visible: boolean;
  employees: Option[];
  onClose: () => void;
  onCreated: () => void;
};

export function AddEntryModal({ visible, employees, onClose, onCreated }: Props) {
  const days = useMemo(buildDays, []);
  const times = useMemo(buildTimes, []);

  const [projects, setProjects] = useState<Option[]>([]);
  const [employeeId, setEmployeeId] = useState<string | null>(null);
  const [dateId, setDateId] = useState<string>(days[0]?.id ?? "");
  const [startId, setStartId] = useState<string | null>(null);
  const [endId, setEndId] = useState<string | null>(null);
  const [projectId, setProjectId] = useState<string | null>(null);
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!visible) return;
    setError(null);
    void getAccessToken().then(async (t) => {
      if (!t) return;
      try {
        const res = await getStatus(t);
        if (res.ok) setProjects(res.data.projects);
      } catch {
        // project list is optional; leave empty on a blip
      }
    });
  }, [visible]);

  function reset() {
    setEmployeeId(null);
    setStartId(null);
    setEndId(null);
    setProjectId(null);
    setNote("");
    setDateId(days[0]?.id ?? "");
    setError(null);
  }

  function cancel() {
    reset();
    onClose();
  }

  async function save() {
    setError(null);
    if (!employeeId) return setError("Pick an employee.");
    if (!startId || !endId) return setError("Pick start and end times.");
    const startIso = toIso(dateId, startId);
    const endIso = toIso(dateId, endId);
    if (!startIso || !endIso) return setError("Invalid time.");
    if (Date.parse(endIso) <= Date.parse(startIso)) {
      return setError("End must be after start.");
    }
    setBusy(true);
    const t = await getAccessToken();
    if (!t) {
      setBusy(false);
      return setError("Not signed in.");
    }
    try {
      const res = await createManagerEntry(t, {
        employeeUserId: employeeId,
        startIso,
        endIso,
        projectId,
        note: note.trim() || null,
      });
      if (res.ok) {
        reset();
        onCreated();
      } else {
        setError("Couldn't add the entry. Try again.");
      }
    } catch {
      setError("No connection. Try again.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal
      visible={visible}
      transparent
      animationType="slide"
      onRequestClose={cancel}
    >
      <Pressable style={styles.backdrop} onPress={cancel}>
        <Pressable style={styles.sheet} onPress={() => {}}>
          <Text style={styles.title}>Add entry</Text>
          <ScrollView style={styles.scroll} keyboardShouldPersistTaps="handled">
            <SelectField
              label="Employee"
              value={employeeId}
              options={employees}
              placeholder="Choose an employee"
              onSelect={setEmployeeId}
            />
            <SelectField
              label="Date"
              value={dateId}
              options={days}
              placeholder="Date"
              onSelect={(v) => setDateId(v ?? days[0]?.id ?? "")}
            />
            <SelectField
              label="Start"
              value={startId}
              options={times}
              placeholder="Start time"
              onSelect={setStartId}
            />
            <SelectField
              label="End"
              value={endId}
              options={times}
              placeholder="End time"
              onSelect={setEndId}
            />
            {hhmmEndsNextDay(startId, endId) ? (
              <Text style={styles.overnight}>Ends the next day.</Text>
            ) : null}
            <SelectField
              label="Project"
              value={projectId}
              options={projects}
              placeholder="No project"
              onSelect={setProjectId}
              noneLabel="No project"
            />
            <TextInput
              style={styles.note}
              placeholder="Note (optional)"
              placeholderTextColor={c.textMuted}
              value={note}
              onChangeText={setNote}
              editable={!busy}
            />
            {error ? <Text style={styles.error}>{error}</Text> : null}
          </ScrollView>
          <View style={styles.actions}>
            <TouchableOpacity onPress={cancel} hitSlop={8}>
              <Text style={styles.cancel}>Cancel</Text>
            </TouchableOpacity>
            <TouchableOpacity
              style={[styles.save, busy && styles.disabled]}
              onPress={save}
              disabled={busy}
            >
              {busy ? (
                <ActivityIndicator color={c.accentText} />
              ) : (
                <Text style={styles.saveText}>Add entry</Text>
              )}
            </TouchableOpacity>
          </View>
        </Pressable>
      </Pressable>
    </Modal>
  );
}

const styles = StyleSheet.create({
  backdrop: {
    flex: 1,
    backgroundColor: scrim,
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
    marginBottom: 8,
  },
  scroll: { paddingHorizontal: 20 },
  /** Says out loud what buildShiftRange does silently when the end time is at
   *  or before the start. */
  overnight: { color: c.textMuted, fontSize: 13, marginTop: -6, marginBottom: 10 },

  note: {
    backgroundColor: c.surface,
    borderColor: c.border,
    borderWidth: 1,
    borderRadius: 14,
    paddingHorizontal: 16,
    paddingVertical: 14,
    color: c.text,
    fontSize: 16,
    marginBottom: 12,
  },
  error: { color: c.danger, fontSize: 14, marginBottom: 8 },
  actions: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingHorizontal: 20,
    paddingTop: 12,
  },
  cancel: { color: c.textMuted, fontSize: 16, fontWeight: "600" },
  save: {
    backgroundColor: c.accent,
    borderRadius: 14,
    paddingVertical: 14,
    paddingHorizontal: 28,
    alignItems: "center",
  },
  disabled: { opacity: 0.6 },
  saveText: { color: c.accentText, fontSize: 16, fontWeight: "700" },
});
