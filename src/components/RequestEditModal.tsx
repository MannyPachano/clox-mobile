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
import { buildEditDays, buildShiftRange, withDay, ymdOf } from "../lib/edit-time";
import { getAccessToken } from "../supabase";
import { lightColors as c } from "../theme";
import { SelectField } from "./SelectField";
import { TimeField } from "./TimeField";

type Props = {
  visible: boolean;
  shift: HistoryShift | null;
  onClose: () => void;
  onSubmitted: () => void;
};

/**
 * An employee proposes a correction to one of their OWN clocked shifts. This
 * does not change the record directly: it creates a request their manager
 * approves or rejects.
 */
export function RequestEditModal({
  visible,
  shift,
  onClose,
  onSubmitted,
}: Props) {
  const days = useMemo(buildEditDays, []);

  const [projects, setProjects] = useState<Option[]>([]);
  const [dateId, setDateId] = useState("");
  const [startTime, setStartTime] = useState(() => new Date());
  const [endTime, setEndTime] = useState(() => new Date());
  const [projectId, setProjectId] = useState<string | null>(null);
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const dayOptions = useMemo(() => withDay(days, dateId), [days, dateId]);

  useEffect(() => {
    if (!shift) return;
    setDateId(ymdOf(shift.start));
    setStartTime(new Date(shift.start));
    setEndTime(new Date(shift.end));
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
    const range = buildShiftRange(dateId, startTime, endTime);
    if (!range.ok) return setError(range.error);
    setBusy(true);
    const t = await getAccessToken();
    if (!t) {
      setBusy(false);
      return setError("Not signed in.");
    }
    try {
      const res = await createEntryEditRequest(t, {
        timeEntryId: shift.id,
        startIso: range.startIso,
        endIso: range.endIso,
        projectId,
        reason: reason.trim() || null,
      });
      if (res.ok) onSubmitted();
      else if (res.status === 409) {
        setError("This shift is already approved. Ask your manager to reopen it first.");
      } else setError("Couldn't send the request. Try again.");
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
              options={dayOptions}
              placeholder="Date"
              onSelect={(v) => setDateId(v ?? dateId)}
            />
            <TimeField label="Start" value={startTime} onChange={setStartTime} />
            <TimeField label="End" value={endTime} onChange={setEndTime} />
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
