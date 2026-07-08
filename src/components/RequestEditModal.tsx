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
} from "react-native";

import {
  createEntryEditRequest,
  getStatus,
  type HistoryShift,
  type Option,
} from "../api";
import { getAccessToken } from "../supabase";
import { lightColors as c } from "../theme";
import { SelectField } from "./SelectField";

const DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const MONTHS = [
  "Jan", "Feb", "Mar", "Apr", "May", "Jun",
  "Jul", "Aug", "Sep", "Oct", "Nov", "Dec",
];

function pad(n: number): string {
  return n.toString().padStart(2, "0");
}

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

function ymdOf(iso: string): string {
  const d = new Date(iso);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

function nearest15(iso: string): string {
  const d = new Date(iso);
  let mins = Math.round((d.getHours() * 60 + d.getMinutes()) / 15) * 15;
  if (mins >= 1440) mins = 1425;
  return `${pad(Math.floor(mins / 60))}:${pad(mins % 60)}`;
}

type Props = {
  visible: boolean;
  shift: HistoryShift | null;
  onClose: () => void;
  onSubmitted: () => void;
};

/**
 * An employee proposes a correction to one of their OWN clocked shifts. This
 * does not change the record directly: it creates a request their manager
 * approves or rejects. Mirrors EditEntryModal, plus a reason field.
 */
export function RequestEditModal({
  visible,
  shift,
  onClose,
  onSubmitted,
}: Props) {
  const days = useMemo(buildDays, []);
  const times = useMemo(buildTimes, []);

  const [projects, setProjects] = useState<Option[]>([]);
  const [dateId, setDateId] = useState("");
  const [startId, setStartId] = useState<string | null>(null);
  const [endId, setEndId] = useState<string | null>(null);
  const [projectId, setProjectId] = useState<string | null>(null);
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!shift) return;
    setDateId(ymdOf(shift.start));
    setStartId(nearest15(shift.start));
    setEndId(nearest15(shift.end));
    setProjectId(shift.projectId);
    setReason("");
    setError(null);
  }, [shift]);

  useEffect(() => {
    if (!visible) return;
    void getAccessToken().then(async (t) => {
      if (!t) return;
      try {
        const res = await getStatus(t);
        if (res.ok) setProjects(res.data.projects);
      } catch {
        // optional
      }
    });
  }, [visible]);

  async function submit() {
    if (!shift) return;
    setError(null);
    if (!startId || !endId) return setError("Pick start and end times.");
    const startIso = toIso(dateId, startId);
    let endIso = toIso(dateId, endId);
    if (!startIso || !endIso) return setError("Invalid time.");
    // End not after start means the shift crosses midnight: roll to next day.
    if (Date.parse(endIso) <= Date.parse(startIso)) {
      endIso = new Date(Date.parse(endIso) + 86_400_000).toISOString();
    }
    setBusy(true);
    const t = await getAccessToken();
    if (!t) {
      setBusy(false);
      return setError("Not signed in.");
    }
    try {
      const res = await createEntryEditRequest(t, {
        timeEntryId: shift.id,
        startIso,
        endIso,
        projectId,
        reason: reason.trim() || null,
      });
      if (res.ok) onSubmitted();
      else setError("Couldn't send the request. Try again.");
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
      onRequestClose={onClose}
    >
      <Pressable style={styles.backdrop} onPress={onClose}>
        <Pressable style={styles.sheet} onPress={() => {}}>
          <Text style={styles.title}>Request a change</Text>
          <Text style={styles.subtitle}>
            Your manager reviews this before it changes your timesheet.
          </Text>
          <ScrollView style={styles.scroll} keyboardShouldPersistTaps="handled">
            <SelectField
              label="Date"
              value={dateId}
              options={days}
              placeholder="Date"
              onSelect={(v) => setDateId(v ?? dateId)}
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
              placeholder="Reason for the change (optional)"
              placeholderTextColor={c.textMuted}
              value={reason}
              onChangeText={setReason}
              editable={!busy}
              multiline
            />
            <Text style={styles.hint}>Times round to 15 minutes.</Text>
            {error ? <Text style={styles.error}>{error}</Text> : null}
          </ScrollView>
          <Pressable style={styles.actions}>
            <TouchableOpacity onPress={onClose} hitSlop={8}>
              <Text style={styles.cancel}>Cancel</Text>
            </TouchableOpacity>
            <TouchableOpacity
              style={[styles.save, busy && styles.disabled]}
              onPress={submit}
              disabled={busy}
            >
              {busy ? (
                <ActivityIndicator color={c.accentText} />
              ) : (
                <Text style={styles.saveText}>Send request</Text>
              )}
            </TouchableOpacity>
          </Pressable>
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
  note: {
    backgroundColor: c.surface,
    borderColor: c.border,
    borderWidth: 1,
    borderRadius: 14,
    paddingHorizontal: 16,
    paddingVertical: 14,
    color: c.text,
    fontSize: 16,
    minHeight: 60,
    marginBottom: 10,
  },
  hint: { color: c.textMuted, fontSize: 12, marginBottom: 8 },
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
