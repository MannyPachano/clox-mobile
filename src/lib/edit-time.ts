import type { Option } from "../api";
import { wallPartsInZone, ymdInZone, zonedWallToUtc } from "./zoned-time";

// Shared time helpers for the shift-edit / correction-request modals, so the
// overnight, DST, and date-window handling lives in one place (and is testable).
//
// Every wall-clock here is interpreted in the ORG's timezone (the `tz`
// threaded through from lib/org-tz), never the device's. A manager describing
// a shift as "7:09 AM to 5:19 PM" means the site's clock; composing those
// picks in a traveling device's own zone produces instants the org never
// described — the server then rightly rejects them (or worse, saves them),
// while every client-side check passed. `tz` undefined falls back to the
// device zone, the pre-org-tz behavior.

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

/** The last 14 days as { id: "YYYY-MM-DD", name } options, newest first.
 *  "Today" is the ORG's today: the ids must line up with the day keys the
 *  seeds produce (ymdOf, same zone), or an entry near midnight preselects
 *  the wrong day on a device across the date line from the org. Iterated in
 *  UTC so subtracting whole days is exact (no device-DST 23/25h days). */
export function buildEditDays(tz: string | undefined): Option[] {
  const today = wallPartsInZone(Date.now(), tz);
  const base = Date.UTC(today.y, today.mo - 1, today.d);
  const out: Option[] = [];
  for (let i = 0; i < 14; i++) {
    const d = new Date(base - i * 86_400_000);
    const id = `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
    const name =
      i === 0
        ? "Today"
        : i === 1
          ? "Yesterday"
          : `${DAYS[d.getUTCDay()]}, ${MONTHS[d.getUTCMonth()]} ${d.getUTCDate()}`;
    out.push({ id, name });
  }
  return out;
}

/** ISO -> the "YYYY-MM-DD" calendar day it falls on in the org zone. */
export function ymdOf(iso: string, tz: string | undefined): string {
  const ms = Date.parse(iso);
  return Number.isNaN(ms) ? "" : ymdInZone(ms, tz);
}

/** Ensure `dateId` is one of the options (for entries older than the 14-day
 *  window), so its real date shows and stays selectable. */
export function withDay(days: Option[], dateId: string): Option[] {
  if (!dateId || days.some((o) => o.id === dateId)) return days;
  const [y, mo, d] = dateId.split("-").map(Number);
  if (!y || !mo || !d) return days;
  return [{ id: dateId, name: labelForDate(new Date(y, mo - 1, d)) }, ...days];
}

/** Combine a "YYYY-MM-DD" day with a picker Date's hour/minute into an ISO —
 *  the wall-clock read in the ORG zone. The picker Date is a display shell
 *  (see zoned-time pickerDateInZone); only its wall fields mean anything. */
function combineIso(
  dateId: string,
  t: Date,
  tz: string | undefined,
): string | null {
  const [y, mo, d] = dateId.split("-").map(Number);
  if (!y || !mo || !d) return null;
  const ms = zonedWallToUtc(
    { y, mo, d, h: t.getHours(), mi: t.getMinutes() },
    tz,
  );
  return Number.isNaN(ms) ? null : new Date(ms).toISOString();
}

/** The "YYYY-MM-DD" of the calendar day after `dateId` (pure date math). */
export function nextDay(dateId: string): string | null {
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
  tz: string | undefined,
): { ok: true; startIso: string } | { ok: false; error: string } {
  const startIso = combineIso(dateId, startTime, tz);
  if (!startIso) return { ok: false, error: "Invalid time." };
  if (Date.parse(startIso) >= Date.now()) {
    return { ok: false, error: "The start time has to be in the past." };
  }
  return { ok: true, startIso };
}

/**
 * Build start/end ISO from a day plus two exact times, in the org zone.
 *  - If end is not after start, it is treated as crossing midnight and rebuilt
 *    on the NEXT calendar day via the same wall-clock time (DST-safe in the
 *    ORG zone — it keeps the clock time instead of adding a raw 24h, which is
 *    wrong on a DST night).
 *  - Rejects an implausibly long span (> 18h) so an AM/PM mix-up can't silently
 *    save a ~23h shift.
 */
export function buildShiftRange(
  dateId: string,
  startTime: Date,
  endTime: Date,
  tz: string | undefined,
):
  | { ok: true; startIso: string; endIso: string }
  | { ok: false; error: string } {
  const startIso = combineIso(dateId, startTime, tz);
  let endIso = combineIso(dateId, endTime, tz);
  if (!startIso || !endIso) return { ok: false, error: "Invalid time." };

  if (Date.parse(endIso) <= Date.parse(startIso)) {
    const nd = nextDay(dateId);
    const rolled = nd ? combineIso(nd, endTime, tz) : null;
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

/**
 * What to tell someone about an end time at or before the start:
 *   null        the shift ends the same day, nothing to say
 *   "next-day"  it rolls over and buildShiftRange will accept it
 *   "too-long"  it rolls over into a span past the 18-hour ceiling, so the
 *               save is going to fail
 *
 * The third case is why this is not just `endsNextDay`. An end in the six
 * hours before the start rolls to a 19-to-24 hour shift, and a bare "Ends the
 * next day." there is a promise the writer then breaks with an unrelated
 * "over 18 hours" error.
 */
export function overnightState(
  start: Date,
  end: Date,
): "next-day" | "too-long" | null {
  if (!endsNextDay(start, end)) return null;
  const s = start.getHours() * 60 + start.getMinutes();
  const e = end.getHours() * 60 + end.getMinutes();
  const rolledMinutes = e + 24 * 60 - s;
  return rolledMinutes * 60_000 > MAX_SHIFT_MS ? "too-long" : "next-day";
}
