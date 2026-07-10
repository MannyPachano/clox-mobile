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

import {
  getStatus,
  updateManagerEntry,
  type EditableEntry,
  type Option,
} from "../api";
import {
  buildEditDays,
  buildRunningStart,
  buildShiftRange,
  withDay,
  ymdOf,
} from "../lib/edit-time";
import { getAccessToken } from "../supabase";
import { lightColors as c } from "../theme";
import { SelectField } from "./SelectField";
import { TimeField } from "./TimeField";

type Props = {
  visible: boolean;
  entry: EditableEntry | null;
  /** Start-only mode for a RUNNING shift: only the Start field shows, the date
   *  is fixed to the shift's start date, and the save sends startIso alone (no
   *  endIso — the shift keeps running). */
  startOnly?: boolean;
  onClose: () => void;
  onSaved: () => void;
};

export function EditEntryModal({
  visible,
  entry,
  startOnly = false,
  onClose,
  onSaved,
}: Props) {
  const days = useMemo(buildEditDays, []);

  const [projects, setProjects] = useState<Option[]>([]);
  const [dateId, setDateId] = useState("");
  const [startTime, setStartTime] = useState(() => new Date());
  const [endTime, setEndTime] = useState(() => new Date());
  const [projectId, setProjectId] = useState<string | null>(null);
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Keep the entry's own date selectable even if it's older than the 14-day list.
  const dayOptions = useMemo(() => withDay(days, dateId), [days, dateId]);

  // Prefill from the entry being edited — exact times, no rounding. Keyed on
  // `visible` too, so reopening the modal for the same entry (e.g. the running
  // shift) starts from the entry's real values, not leftover edits.
  useEffect(() => {
    if (!visible || !entry) return;
    setDateId(ymdOf(entry.start));
    setStartTime(new Date(entry.start));
    setEndTime(entry.end ? new Date(entry.end) : new Date());
    setProjectId(entry.projectId);
    setNote(entry.note ?? "");
    setError(null);
  }, [visible, entry]);

  useEffect(() => {
    // Start-only mode has no project picker, so skip the fetch.
    if (!visible || startOnly) return;
    void getAccessToken().then(async (t) => {
      if (!t) return;
      try {
        const res = await getStatus(t);
        if (res.ok) setProjects(res.data.projects);
      } catch {
        // optional
      }
    });
  }, [visible, startOnly]);

  async function save() {
    if (!entry) return;
    setError(null);
    // Start-only (running shift): send the new start alone. No endIso — the
    // server keeps the shift open. Completed entries send the full range.
    let payload: Parameters<typeof updateManagerEntry>[1];
    if (startOnly) {
      const start = buildRunningStart(dateId, startTime);
      if (!start.ok) return setError(start.error);
      payload = { id: entry.id, startIso: start.startIso };
    } else {
      const range = buildShiftRange(dateId, startTime, endTime);
      if (!range.ok) return setError(range.error);
      payload = {
        id: entry.id,
        startIso: range.startIso,
        endIso: range.endIso,
        projectId,
        note: note.trim() || null,
      };
    }
    setBusy(true);
    const t = await getAccessToken();
    if (!t) {
      setBusy(false);
      return setError("Not signed in.");
    }
    try {
      const res = await updateManagerEntry(t, payload);
      if (res.ok) onSaved();
      else if (res.status === 409) {
        setError("This entry is locked (already approved). Unlock it on the web to edit.");
      } else setError("Couldn't save. Try again.");
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
          <Text style={styles.title}>
            {startOnly ? "Adjust start time" : "Edit entry"}
          </Text>
          {entry?.employee ? (
            <Text style={styles.who}>{entry.employee}</Text>
          ) : null}
          <ScrollView style={styles.scroll} keyboardShouldPersistTaps="handled">
            {/* The date shows in startOnly mode too: an overnight shift's
                real start can be the previous day, and pinning the date
                would make that correction impossible. buildRunningStart
                still rejects anything not in the past. */}
            <SelectField
              label="Date"
              value={dateId}
              options={dayOptions}
              placeholder="Date"
              onSelect={(v) => setDateId(v ?? dateId)}
            />
            <TimeField label="Start" value={startTime} onChange={setStartTime} />
            {!startOnly ? (
              <>
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
                  placeholder="Note (optional)"
                  placeholderTextColor={c.textMuted}
                  value={note}
                  onChangeText={setNote}
                  editable={!busy}
                />
              </>
            ) : null}
            <Text style={styles.hint}>
              {startOnly
                ? "The shift keeps running. Only the start time changes."
                : "Saving re-opens the entry for approval."}
            </Text>
            {error ? <Text style={styles.error}>{error}</Text> : null}
          </ScrollView>
          <View style={styles.actions}>
            <TouchableOpacity onPress={onClose} hitSlop={8}>
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
                <Text style={styles.saveText}>Save</Text>
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
  who: {
    color: c.textMuted,
    fontSize: 15,
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
