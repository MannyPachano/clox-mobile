import { useEffect, useMemo, useState } from "react";
import {
  ActivityIndicator,
  Modal,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from "react-native";

import {
  createManagerShift,
  updateManagerShift,
  type Option,
  type ScheduledShiftDto,
} from "../api";
import { getAccessToken } from "../supabase";
import { lightColors as c, scrim } from "../theme";
import { SelectField } from "./SelectField";

const DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const MONTHS = [
  "Jan", "Feb", "Mar", "Apr", "May", "Jun",
  "Jul", "Aug", "Sep", "Oct", "Nov", "Dec",
];

function pad(n: number): string {
  return n.toString().padStart(2, "0");
}

/** Next 42 days as options, id = "YYYY-MM-DD" (local) — scheduling looks ahead. */
function buildDays(): Option[] {
  const base = new Date();
  base.setHours(0, 0, 0, 0);
  const out: Option[] = [];
  for (let i = 0; i < 42; i++) {
    const d = new Date(base.getTime() + i * 86_400_000);
    const id = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
    const name =
      i === 0
        ? "Today"
        : i === 1
          ? "Tomorrow"
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

/** ISO → "YYYY-MM-DD" (local), for seeding the date picker when editing. */
function ymdOf(iso: string): string {
  const d = new Date(iso);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/** ISO → nearest-15-min "HH:MM" so it matches a time option when editing. */
function nearest15(iso: string): string {
  const d = new Date(iso);
  let mins = Math.round((d.getHours() * 60 + d.getMinutes()) / 15) * 15;
  if (mins >= 1440) mins = 1425;
  return `${pad(Math.floor(mins / 60))}:${pad(mins % 60)}`;
}

type Props = {
  visible: boolean;
  employees: Option[];
  /** Pre-select a date (id = "YYYY-MM-DD") when opened from a specific day. */
  initialDateId?: string;
  /** When set, the modal edits this shift instead of creating a new one. */
  shift?: ScheduledShiftDto | null;
  onClose: () => void;
  onCreated: () => void;
  onUpdated?: () => void;
  onRemove?: (shift: ScheduledShiftDto) => void;
};

export function AddShiftModal({
  visible,
  employees,
  initialDateId,
  shift,
  onClose,
  onCreated,
  onUpdated,
  onRemove,
}: Props) {
  const days = useMemo(buildDays, []);
  const times = useMemo(buildTimes, []);
  const editing = shift != null;

  // When editing a shift whose date is outside the default add-window (e.g. an
  // earlier day of the current week, or a series occurrence), make sure that
  // date is still a selectable, correctly-labelled option.
  const dayOptions = useMemo(() => {
    if (!shift) return days;
    const sid = ymdOf(shift.startsAt);
    if (days.some((o) => o.id === sid)) return days;
    const [y, mo, d] = sid.split("-").map(Number);
    const dt = new Date(y, mo - 1, d);
    const name = `${DAYS[dt.getDay()]}, ${MONTHS[dt.getMonth()]} ${dt.getDate()}`;
    return [{ id: sid, name }, ...days];
  }, [days, shift]);

  const [employeeId, setEmployeeId] = useState<string | null>(null);
  const [dateId, setDateId] = useState<string>(initialDateId ?? "");
  const [startId, setStartId] = useState<string | null>("09:00");
  const [endId, setEndId] = useState<string | null>("17:00");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Seed each time the sheet opens: from the shift when editing, else defaults.
  useEffect(() => {
    if (!visible) return;
    if (shift) {
      setEmployeeId(shift.employeeUserId);
      setDateId(ymdOf(shift.startsAt));
      setStartId(nearest15(shift.startsAt));
      setEndId(nearest15(shift.endsAt));
    } else {
      setEmployeeId(null);
      setDateId(initialDateId ?? days[0]?.id ?? "");
      setStartId("09:00");
      setEndId("17:00");
    }
    setError(null);
  }, [visible, shift, initialDateId, days]);

  function cancel() {
    setError(null);
    onClose();
  }

  async function save() {
    setError(null);
    if (!employeeId) return setError("Pick an employee.");
    if (!startId || !endId) return setError("Pick start and end times.");
    const startIso = toIso(dateId, startId);
    let endIso = toIso(dateId, endId);
    if (!startIso || !endIso) return setError("Invalid time.");
    // End not after start means the shift crosses midnight (a night crew): roll
    // the end to the next day rather than rejecting it.
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
      if (shift) {
        const res = await updateManagerShift(t, {
          id: shift.id,
          startIso,
          endIso,
          employeeUserId: employeeId,
        });
        if (res.ok) onUpdated?.();
        else setError("Couldn't save the shift. Try again.");
      } else {
        const res = await createManagerShift(t, {
          employeeUserId: employeeId,
          startIso,
          endIso,
        });
        if (res.ok) onCreated();
        else setError("Couldn't add the shift. Try again.");
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
          <Text style={styles.title}>
            {editing ? "Edit shift" : "Schedule a shift"}
          </Text>
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
              options={dayOptions}
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
            <Text style={styles.hint}>
              {shift?.isSeries
                ? "This edits only this one shift. Change the repeating series on the web."
                : "For repeating shifts, use the web app."}
            </Text>
            {error ? <Text style={styles.error}>{error}</Text> : null}
            {editing && onRemove && shift ? (
              <TouchableOpacity
                style={styles.remove}
                onPress={() => onRemove(shift)}
                disabled={busy}
              >
                <Text style={styles.removeText}>Remove shift</Text>
              </TouchableOpacity>
            ) : null}
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
                <Text style={styles.saveText}>
                  {editing ? "Save" : "Schedule"}
                </Text>
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
  hint: { color: c.textMuted, fontSize: 13, marginTop: 2, marginBottom: 8 },
  error: { color: c.danger, fontSize: 14, marginBottom: 8 },
  remove: { alignItems: "center", paddingVertical: 10, marginBottom: 2 },
  removeText: { color: c.danger, fontSize: 15, fontWeight: "600" },
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
