import { useEffect, useMemo, useRef, useState } from "react";
import {
  ActivityIndicator,
  KeyboardAvoidingView,
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
  overnightState,
  withDay,
  ymdOf,
} from "../lib/edit-time";
import { getOrgTz } from "../lib/org-tz";
import { saveErrorMessage } from "../lib/save-error";
import { pickerDateInZone, sameWallFields } from "../lib/zoned-time";
import { getAccessToken } from "../supabase";
import { lightColors as c, scrim, ThemeContext } from "../theme";
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
  // The org zone the pickers were SEEDED in, frozen per open. Seeding and
  // composing must use the same zone: if the zone arrived (or changed)
  // between the seed and the save, wall values seeded in one zone would
  // compose in another — exactly the corruption this exists to prevent.
  const [tz, setTz] = useState<string | undefined>(undefined);
  const days = useMemo(() => buildEditDays(tz), [tz]);

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

  // Prefill from the entry being edited — exact times, no rounding, in the
  // ORG's zone (the pickers show the site's clock, matching what the web
  // shows and what the manager means). Keyed on `visible` too, so reopening
  // the modal for the same entry (e.g. the running shift) starts from the
  // entry's real values, not leftover edits.
  // What the pickers were seeded WITH, so save() can tell an untouched
  // picker apart and send the entry's ORIGINAL ISO instead of recomposing.
  // Wall fields alone cannot represent every instant (the fall-back hour's
  // second pass, or an org time inside the device zone's DST gap), so a
  // recompose of untouched values can silently move a stored time by an
  // hour twice a year. Original-when-untouched removes that entirely.
  const seedRef = useRef<{
    dateId: string;
    startIso: string;
    startShell: Date;
    endIso: string | null;
    endShell: Date;
  } | null>(null);

  useEffect(() => {
    if (!visible || !entry) return;
    const zone = getOrgTz();
    setTz(zone);
    const day = ymdOf(entry.start, zone);
    const startShell = pickerDateInZone(entry.start, zone);
    const endShell = pickerDateInZone(
      entry.end ?? new Date().toISOString(),
      zone,
    );
    seedRef.current = {
      dateId: day,
      startIso: entry.start,
      startShell,
      endIso: entry.end ?? null,
      endShell,
    };
    setDateId(day);
    setStartTime(startShell);
    setEndTime(endShell);
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
    // An untouched picker sends the entry's original ISO (see seedRef).
    const seed = seedRef.current;
    const keepStart =
      seed != null &&
      dateId === seed.dateId &&
      sameWallFields(startTime, seed.startShell);
    let payload: Parameters<typeof updateManagerEntry>[1];
    if (startOnly) {
      const start = buildRunningStart(dateId, startTime, tz);
      if (!start.ok) return setError(start.error);
      payload = {
        id: entry.id,
        startIso: keepStart ? seed.startIso : start.startIso,
      };
    } else {
      const range = buildShiftRange(dateId, startTime, endTime, tz);
      if (!range.ok) return setError(range.error);
      const keepEnd =
        seed != null &&
        seed.endIso != null &&
        dateId === seed.dateId &&
        sameWallFields(endTime, seed.endShell);
      payload = {
        id: entry.id,
        startIso: keepStart ? seed.startIso : range.startIso,
        endIso: keepEnd ? (seed.endIso ?? range.endIso) : range.endIso,
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
      } else {
        // Say the server's reason when it gave one (the codes are stable);
        // the generic line is only for codes we can't say anything true
        // about. This route's bad_range causes: unparseable times, end not
        // after start, or a window that strands a logged break — so the
        // override may honestly mention breaks.
        setError(
          saveErrorMessage(res.error, "Couldn't save. Try again.", {
            bad_range:
              "Those times don't fit this shift. Check them, and any breaks logged inside the shift.",
          }),
        );
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
      onRequestClose={onClose}
    >
      {/* The keyboard must never cover the note input or the Save button.
          behavior="padding" on BOTH platforms: the transparent Modal spans
          the full screen so the padding math is exact with no offset — and
          on Android it is the ONLY mechanism that works here, because under
          SDK 54's forced edge-to-edge an RN Modal's dialog window never
          honors adjustResize (its decor doesn't fit system windows, which
          makes SOFT_INPUT_ADJUST_RESIZE a documented no-op). LoginScreen's
          ios-only split is for the main activity window, where resize does
          work; that split does not transfer to Modals. */}
      <KeyboardAvoidingView style={styles.kav} behavior="padding">
      {/* This sheet is always light (its own styles use lightColors), but
          SelectField follows the theme context, and the Clock screen sets
          that to its dark on-shift palette. Without this, the Date and
          Project fields draw dark on the light sheet, with a label at 2.2:1
          against it. */}
      <ThemeContext.Provider value={c}>
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
                {overnightState(startTime, endTime) === "next-day" ? (
                  <Text style={styles.overnight}>Ends the next day.</Text>
                ) : overnightState(startTime, endTime) === "too-long" ? (
                  <Text style={styles.overnightBad}>
                    That would run past 18 hours. Check the end time.
                  </Text>
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
      </ThemeContext.Provider>
      </KeyboardAvoidingView>
    </Modal>
  );
}

const styles = StyleSheet.create({
  kav: { flex: 1 },
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
  /** Says out loud what buildShiftRange does silently when the end time is at
   *  or before the start. */
  overnightBad: { color: c.danger, fontSize: 13, marginTop: -6, marginBottom: 10 },
  overnight: { color: c.textMuted, fontSize: 13, marginTop: -6, marginBottom: 10 },
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
