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

import { createManagerShift, type Option } from "../api";
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

type Props = {
  visible: boolean;
  employees: Option[];
  /** Pre-select a date (id = "YYYY-MM-DD") when opened from a specific day. */
  initialDateId?: string;
  onClose: () => void;
  onCreated: () => void;
};

export function AddShiftModal({
  visible,
  employees,
  initialDateId,
  onClose,
  onCreated,
}: Props) {
  const days = useMemo(buildDays, []);
  const times = useMemo(buildTimes, []);
  const fallbackDate = initialDateId ?? days[0]?.id ?? "";

  const [employeeId, setEmployeeId] = useState<string | null>(null);
  const [dateId, setDateId] = useState<string>(fallbackDate);
  const [startId, setStartId] = useState<string | null>("09:00");
  const [endId, setEndId] = useState<string | null>("17:00");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Re-seed the date each time the sheet opens (the manager may have changed week).
  useEffect(() => {
    if (visible) {
      setDateId(initialDateId ?? days[0]?.id ?? "");
      setError(null);
    }
  }, [visible, initialDateId, days]);

  function reset() {
    setEmployeeId(null);
    setStartId("09:00");
    setEndId("17:00");
    setDateId(fallbackDate);
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
      const res = await createManagerShift(t, {
        employeeUserId: employeeId,
        startIso,
        endIso,
      });
      if (res.ok) {
        reset();
        onCreated();
      } else {
        setError("Couldn't add the shift. Try again.");
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
          <Text style={styles.title}>Schedule a shift</Text>
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
            <Text style={styles.hint}>
              For repeating shifts, use the web app.
            </Text>
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
                <Text style={styles.saveText}>Schedule</Text>
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
    marginBottom: 8,
  },
  scroll: { paddingHorizontal: 20 },
  hint: { color: c.textMuted, fontSize: 13, marginTop: 2, marginBottom: 8 },
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
