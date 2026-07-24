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

import { createManagerEntry, getStatus, type Option } from "../api";
import { buildEditDays } from "../lib/edit-time";
import { getOrgTz } from "../lib/org-tz";
import { saveErrorMessage } from "../lib/save-error";
import { zonedWallToUtc } from "../lib/zoned-time";
import { getAccessToken } from "../supabase";
import { lightColors as c, scrim } from "../theme";
import { SelectField } from "./SelectField";

function pad(n: number): string {
  return n.toString().padStart(2, "0");
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

/** Compose a day + "HH:MM" as ORG wall-clock into an ISO instant. A manager
 *  adding "9:00 AM" means the site's morning, whatever zone their phone is
 *  in — device-zone composition here is how a traveling manager writes a
 *  shift the org never worked. */
function toIso(
  dateId: string,
  timeId: string,
  tz: string | undefined,
): string | null {
  const [y, mo, d] = dateId.split("-").map(Number);
  const [h, mi] = timeId.split(":").map(Number);
  if (!y || !mo || !d || Number.isNaN(h) || Number.isNaN(mi)) return null;
  const ms = zonedWallToUtc({ y, mo, d, h, mi }, tz);
  return Number.isNaN(ms) ? null : new Date(ms).toISOString();
}

type Props = {
  visible: boolean;
  employees: Option[];
  onClose: () => void;
  onCreated: () => void;
};

export function AddEntryModal({ visible, employees, onClose, onCreated }: Props) {
  // The org zone the picks compose in, frozen per open (see EditEntryModal).
  const [tz, setTz] = useState<string | undefined>(undefined);
  const days = useMemo(() => buildEditDays(tz), [tz]);
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
  // Only a date the USER picked survives a reopen. The mount-time default is
  // built before the org zone is known (device zone), and near midnight the
  // device's today is the org's yesterday — keeping that stale default would
  // open the first Add entry with "Yesterday" preselected.
  const datePicked = useRef(false);

  useEffect(() => {
    if (!visible) return;
    setError(null);
    const zone = getOrgTz();
    setTz(zone);
    // The day list is zone-dependent; keep a pick the user actually made
    // when it is still in the fresh list (the ids are stable "YYYY-MM-DD"
    // strings), else default to the org's today.
    const fresh = buildEditDays(zone);
    setDateId((cur) =>
      datePicked.current && fresh.some((d) => d.id === cur)
        ? cur
        : (fresh[0]?.id ?? ""),
    );
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
    datePicked.current = false;
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
    const startIso = toIso(dateId, startId, tz);
    const endIso = toIso(dateId, endId, tz);
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
        setError(
          saveErrorMessage(res.error, "Couldn't add the entry. Try again."),
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
      onRequestClose={cancel}
    >
      {/* Keeps the note input and the actions above the keyboard.
          behavior="padding" on BOTH platforms: an RN Modal's dialog window
          never honors adjustResize under SDK 54's forced edge-to-edge, so
          padding is the only mechanism that works on Android too (see
          EditEntryModal for the full story). */}
      <KeyboardAvoidingView style={styles.kav} behavior="padding">
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
              onSelect={(v) => {
                datePicked.current = true;
                setDateId(v ?? days[0]?.id ?? "");
              }}
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
