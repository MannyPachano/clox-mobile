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
import { nextDay } from "../lib/edit-time";
import { getOrgTz } from "../lib/org-tz";
import { saveErrorMessage } from "../lib/save-error";
import { wallPartsInZone, ymdInZone, zonedWallToUtc } from "../lib/zoned-time";
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

/** Next 42 days as options, id = "YYYY-MM-DD" — scheduling looks ahead.
 *  "Today" is the ORG's today (a schedule describes the site's days), and
 *  the iteration runs in UTC so adding whole days is exact across DST. */
function buildDays(tz: string | undefined): Option[] {
  const today = wallPartsInZone(Date.now(), tz);
  const base = Date.UTC(today.y, today.mo - 1, today.d);
  const out: Option[] = [];
  for (let i = 0; i < 42; i++) {
    const d = new Date(base + i * 86_400_000);
    const id = `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
    const name =
      i === 0
        ? "Today"
        : i === 1
          ? "Tomorrow"
          : `${DAYS[d.getUTCDay()]}, ${MONTHS[d.getUTCMonth()]} ${d.getUTCDate()}`;
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

/** Compose a day + "HH:MM" as ORG wall-clock into an ISO instant. A schedule
 *  says when the SITE works; "9:00 AM" composed in a traveling manager's
 *  device zone would land the crew hours off on the web board. */
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

/** ISO → the org-zone "YYYY-MM-DD", for seeding the date picker when editing. */
function ymdOf(iso: string, tz: string | undefined): string {
  const ms = Date.parse(iso);
  return Number.isNaN(ms) ? "" : ymdInZone(ms, tz);
}

/** ISO → nearest-15-min "HH:MM" in the org zone, matching a time option. */
function nearest15(iso: string, tz: string | undefined): string {
  const ms = Date.parse(iso);
  if (Number.isNaN(ms)) return "09:00";
  const w = wallPartsInZone(ms, tz);
  let mins = Math.round((w.h * 60 + w.mi) / 15) * 15;
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
  // The org zone the picks compose in, frozen per open (see EditEntryModal:
  // seeding and composing must share one zone).
  const [tz, setTz] = useState<string | undefined>(undefined);
  const days = useMemo(() => buildDays(tz), [tz]);
  const times = useMemo(buildTimes, []);
  const editing = shift != null;

  // When editing a shift whose date is outside the default add-window (e.g. an
  // earlier day of the current week, or a series occurrence), make sure that
  // date is still a selectable, correctly-labelled option.
  const dayOptions = useMemo(() => {
    if (!shift) return days;
    const sid = ymdOf(shift.startsAt, tz);
    if (!sid || days.some((o) => o.id === sid)) return days;
    const [y, mo, d] = sid.split("-").map(Number);
    const dt = new Date(y, mo - 1, d);
    const name = `${DAYS[dt.getDay()]}, ${MONTHS[dt.getMonth()]} ${dt.getDate()}`;
    return [{ id: sid, name }, ...days];
  }, [days, shift, tz]);

  const [employeeId, setEmployeeId] = useState<string | null>(null);
  const [dateId, setDateId] = useState<string>(initialDateId ?? "");
  const [startId, setStartId] = useState<string | null>("09:00");
  const [endId, setEndId] = useState<string | null>("17:00");

  // Exactly save()'s test, run on the same values: a string compare of the
  // option ids drifts from the timestamps on a spring-forward date, where a
  // non-existent local hour normalises forward.
  const rollsToNextDay = useMemo(() => {
    if (!startId || !endId) return false;
    const a = toIso(dateId, startId, tz);
    const b = toIso(dateId, endId, tz);
    if (!a || !b) return false;
    return Date.parse(b) <= Date.parse(a);
  }, [dateId, startId, endId, tz]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Seed each time the sheet opens: from the shift when editing, else defaults.
  useEffect(() => {
    if (!visible) return;
    const zone = getOrgTz();
    setTz(zone);
    if (shift) {
      setEmployeeId(shift.employeeUserId);
      setDateId(ymdOf(shift.startsAt, zone));
      setStartId(nearest15(shift.startsAt, zone));
      setEndId(nearest15(shift.endsAt, zone));
    } else {
      setEmployeeId(null);
      setDateId(initialDateId ?? buildDays(zone)[0]?.id ?? "");
      setStartId("09:00");
      setEndId("17:00");
    }
    setError(null);
  }, [visible, shift, initialDateId]);

  function cancel() {
    setError(null);
    onClose();
  }

  async function save() {
    setError(null);
    if (!employeeId) return setError("Pick an employee.");
    if (!startId || !endId) return setError("Pick start and end times.");
    const startIso = toIso(dateId, startId, tz);
    let endIso = toIso(dateId, endId, tz);
    if (!startIso || !endIso) return setError("Invalid time.");
    // End not after start means the shift crosses midnight (a night crew):
    // roll the end to the next day rather than rejecting it. Rebuilt from the
    // next day's WALL clock, not by adding a raw 24h — on a DST night those
    // differ by an hour, and the crew's "6 PM to 2:30 AM" means the clock on
    // the wall both evenings.
    if (Date.parse(endIso) <= Date.parse(startIso)) {
      const nd = nextDay(dateId);
      const rolled = nd ? toIso(nd, endId, tz) : null;
      if (!rolled) return setError("Invalid time.");
      endIso = rolled;
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
        else
          setError(
            saveErrorMessage(res.error, "Couldn't save the shift. Try again."),
          );
      } else {
        const res = await createManagerShift(t, {
          employeeUserId: employeeId,
          startIso,
          endIso,
        });
        if (res.ok) onCreated();
        else
          setError(
            saveErrorMessage(res.error, "Couldn't add the shift. Try again."),
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
            {rollsToNextDay ? (
              <Text style={styles.overnight}>Ends the next day.</Text>
            ) : null}
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
  /** Says out loud what buildShiftRange does silently when the end time is at
   *  or before the start. */
  overnight: { color: c.textMuted, fontSize: 13, marginTop: -6, marginBottom: 10 },

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
