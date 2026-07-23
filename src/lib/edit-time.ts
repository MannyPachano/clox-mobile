import type { Option } from "../api";

// Shared time helpers for the shift-edit / correction-request modals, so the
// overnight, DST, and date-window handling lives in one place (and is testable).

const DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const MONTHS = [
  "Jan", "Feb", "Mar", "Apr", "May", "Jun",
  "Jul", "Aug", "Sep", "Oct", "Nov", "Dec",
];

/** A genuine overnight shift is well under this; longer means an AM/PM mistake. */
const MAX_SHIFT_MS = 18 * 3_600_000;

function pad(n: number): string {
  return n.toString().padStart(2, "0");
}

function labelForDate(d: Date): string {
  return `${DAYS[d.getDay()]}, ${MONTHS[d.getMonth()]} ${d.getDate()}`;
}

/** The last 14 days as { id: "YYYY-MM-DD", name } options, newest first. */
export function buildEditDays(): Option[] {
  const base = new Date();
  base.setHours(0, 0, 0, 0);
  const out: Option[] = [];
  for (let i = 0; i < 14; i++) {
    const d = new Date(base.getTime() - i * 86_400_000);
    const id = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
    const name =
      i === 0 ? "Today" : i === 1 ? "Yesterday" : labelForDate(d);
    out.push({ id, name });
  }
  return out;
}

/** ISO -> local "YYYY-MM-DD". */
export function ymdOf(iso: string): string {
  const d = new Date(iso);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/** Ensure `dateId` is one of the options (for entries older than the 14-day
 *  window), so its real date shows and stays selectable. */
export function withDay(days: Option[], dateId: string): Option[] {
  if (!dateId || days.some((o) => o.id === dateId)) return days;
  const [y, mo, d] = dateId.split("-").map(Number);
  if (!y || !mo || !d) return days;
  return [{ id: dateId, name: labelForDate(new Date(y, mo - 1, d)) }, ...days];
}

/** Combine a "YYYY-MM-DD" day with a Date's exact hour/minute into an ISO. */
function combineIso(dateId: string, t: Date): string | null {
  const [y, mo, d] = dateId.split("-").map(Number);
  if (!y || !mo || !d) return null;
  const dt = new Date(y, mo - 1, d, t.getHours(), t.getMinutes(), 0, 0);
  return Number.isNaN(dt.getTime()) ? null : dt.toISOString();
}

/** The local "YYYY-MM-DD" of the day after `dateId`. */
function nextDay(dateId: string): string | null {
  const [y, mo, d] = dateId.split("-").map(Number);
  if (!y || !mo || !d) return null;
  const dt = new Date(y, mo - 1, d + 1);
  return `${dt.getFullYear()}-${pad(dt.getMonth() + 1)}-${pad(dt.getDate())}`;
}

/**
 * Build just a start ISO for a start-only edit of a RUNNING shift (the day is
 * fixed to the shift's start date; there is no end yet). The start must land
 * in the past — a running shift can't have started in the future.
 */
export function buildRunningStart(
  dateId: string,
  startTime: Date,
): { ok: true; startIso: string } | { ok: false; error: string } {
  const startIso = combineIso(dateId, startTime);
  if (!startIso) return { ok: false, error: "Invalid time." };
  if (Date.parse(startIso) >= Date.now()) {
    return { ok: false, error: "The start time has to be in the past." };
  }
  return { ok: true, startIso };
}

/**
 * Build start/end ISO from a day plus two exact times.
 *  - If end is not after start, it is treated as crossing midnight and rebuilt
 *    on the NEXT local day via the same wall-clock time (DST-safe — it keeps the
 *    clock time instead of adding a raw 24h, which is wrong on a DST night).
 *  - Rejects an implausibly long span (> 18h) so an AM/PM mix-up can't silently
 *    save a ~23h shift.
 */
export function buildShiftRange(
  dateId: string,
  startTime: Date,
  endTime: Date,
):
  | { ok: true; startIso: string; endIso: string }
  | { ok: false; error: string } {
  const startIso = combineIso(dateId, startTime);
  let endIso = combineIso(dateId, endTime);
  if (!startIso || !endIso) return { ok: false, error: "Invalid time." };

  if (Date.parse(endIso) <= Date.parse(startIso)) {
    const nd = nextDay(dateId);
    const rolled = nd ? combineIso(nd, endTime) : null;
    if (!rolled) return { ok: false, error: "Invalid time." };
    endIso = rolled;
  }

  if (Date.parse(endIso) - Date.parse(startIso) > MAX_SHIFT_MS) {
    return {
      ok: false,
      error:
        "Check the times — this shift is over 18 hours. If you meant PM, fix the end time.",
    };
  }
  return { ok: true, startIso, endIso };
}

/**
 * True when the chosen end is at or before the start.
 *
 * Every writer in the app resolves that by rolling the end into the next day
 * (see `buildShiftRange` above), which is right but silent: a 6:00 PM to
 * 2:30 AM shift looks like a typo until the sheet says otherwise.
 */
export function endsNextDay(start: Date, end: Date): boolean {
  const s = start.getHours() * 60 + start.getMinutes();
  const e = end.getHours() * 60 + end.getMinutes();
  return e <= s;
}

/** The same question for the zero-padded "HH:MM" option ids the schedule and
 *  add-entry sheets pick from, where a string compare is the time compare. */
export function hhmmEndsNextDay(
  startId: string | null,
  endId: string | null,
): boolean {
  if (!startId || !endId) return false;
  return endId <= startId;
}
