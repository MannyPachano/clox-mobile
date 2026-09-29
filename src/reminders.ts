/**
 * Reminders the phone schedules for itself: one before each scheduled shift
 * and one when a running shift passes N hours. The decisions live here, pure
 * (no React, no React Native, no expo-notifications, no AsyncStorage, no
 * Intl), so a plain node script can check them: which reminders should exist
 * for a given schedule, preference, running shift and moment; the identifier
 * each one is scheduled under; what it says; and which scheduled ones to
 * cancel. src/reminder-notifications.ts carries the plan out.
 *
 * Idempotent by construction. A reminder's identifier is built from what it
 * is for, when it fires and what it says, so the same inputs always produce
 * the same identifiers, across app restarts too. Syncing compares identifiers
 * only: anything of ours that is scheduled but no longer wanted is cancelled,
 * anything wanted that is missing is scheduled, and the rest is left alone. A
 * moved shift, a changed preference or a new org zone changes the identifier,
 * so the old reminder is cancelled and the new one takes its place.
 *
 * Times are the ORG's wall-clock, never the phone's zone. This module does
 * not convert zones itself: the caller passes `wallClock`, which answers with
 * the org wall-clock for an instant or null when it cannot (org zone unknown,
 * or unknown to this phone). A null means no reminder for that shift rather
 * than one that names a time in the wrong zone.
 */

const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;

/** Shift reminders cover shifts that start within this long from now. */
export const SHIFT_REMINDER_HORIZON_MS = 7 * DAY_MS;
/** At most this many shift reminders are scheduled at once. iOS keeps only
 *  the 64 soonest pending notifications per app, and the long shift reminder
 *  needs one too. */
export const MAX_SHIFT_REMINDERS = 20;
/** A reminder that is not scheduled yet is only scheduled when it fires at
 *  least this far ahead. A date already past (or about to pass while the
 *  call is on its way) could show right away. One that is already scheduled
 *  is kept until it fires. */
export const MIN_LEAD_MS = 60_000;
/** While a shift is running, no shift reminder fires within this long of
 *  the clock-in: the shift it is for is most likely the one being worked
 *  (clocked in early), and "Open Clox to clock in" would be wrong. The next
 *  sync after a clock-out schedules it again if it is still ahead. */
export const ON_SHIFT_HOLD_MS = 12 * HOUR_MS;

/** The value the Reminders screen saves when a switch is turned on. The
 *  server accepts exactly these today. */
export const DEFAULT_SHIFT_REMINDER_MINUTES = 10;
export const DEFAULT_LONG_SHIFT_HOURS = 10;

/** Every identifier this module builds starts with this. Sign-out cancels
 *  everything under it. */
export const REMINDER_ID_PREFIX = "clox.reminder.";
export const SHIFT_REMINDER_ID_PREFIX = `${REMINDER_ID_PREFIX}shift.`;
export const LONG_SHIFT_ID_PREFIX = `${REMINDER_ID_PREFIX}long.`;

/** The Android channel local reminders post to. */
export const REMINDER_CHANNEL_ID = "reminders";

/** `data.type` on the notifications. The first two are scheduled here; the
 *  third is the server's push to managers (web lib/refused-punch.ts). */
export const SHIFT_REMINDER_TYPE = "shift_start";
export const LONG_SHIFT_TYPE = "long_shift";
export const REFUSED_PUNCH_TYPE = "refused_punch";

/** The three preferences, as GET status carries them. */
export type ReminderPrefs = {
  /** null (off) or minutes before a scheduled shift. */
  shiftReminderMinutes: number | null;
  /** null (off) or hours into a running shift. */
  longShiftHours: number | null;
  /** Managers only: a push when an employee's clock-in is refused. */
  notifyRefusedPunch: boolean;
};

export const PREFS_OFF: ReminderPrefs = {
  shiftReminderMinutes: null,
  longShiftHours: null,
  notifyRefusedPunch: false,
};

export type ReminderField = keyof ReminderPrefs;

/** A whole number in [min, max], else null. Anything odd reads as off, so a
 *  malformed payload can never schedule a strange reminder. */
function wholeInRange(v: unknown, min: number, max: number): number | null {
  return typeof v === "number" &&
    Number.isInteger(v) &&
    v >= min &&
    v <= max
    ? v
    : null;
}

/**
 * The preferences in a status payload or a save answer, or null when there
 * are none (a server that predates the field). The server allows only 10 for
 * each number today; a later one may offer more, so any sensible whole number
 * is honoured and the screens say the number they were given.
 */
export function parseReminderPrefs(v: unknown): ReminderPrefs | null {
  if (!v || typeof v !== "object" || Array.isArray(v)) return null;
  const o = v as Record<string, unknown>;
  return {
    shiftReminderMinutes: wholeInRange(o.shiftReminderMinutes, 1, 120),
    longShiftHours: wholeInRange(o.longShiftHours, 1, 24),
    notifyRefusedPunch: o.notifyRefusedPunch === true,
  };
}

/** The body a switch saves: one field, on or off. */
export function prefsPatch(
  field: ReminderField,
  on: boolean,
): Partial<ReminderPrefs> {
  switch (field) {
    case "shiftReminderMinutes":
      return { shiftReminderMinutes: on ? DEFAULT_SHIFT_REMINDER_MINUTES : null };
    case "longShiftHours":
      return { longShiftHours: on ? DEFAULT_LONG_SHIFT_HOURS : null };
    case "notifyRefusedPunch":
      return { notifyRefusedPunch: on };
  }
}

export function isOn(prefs: ReminderPrefs | null, field: ReminderField): boolean {
  if (!prefs) return false;
  const v = prefs[field];
  return typeof v === "number" ? v > 0 : v === true;
}

// ── The on-disk copy (last known preferences, per user) ────────────────────

type StoredPrefs = { userId: string; prefs: ReminderPrefs };

/** The cached preferences for `userId`, or null: nothing stored, another
 *  user's entry, or anything malformed. */
export function parsePrefsCache(
  raw: string | null,
  userId: string,
): ReminderPrefs | null {
  if (!raw) return null;
  try {
    const v = JSON.parse(raw) as unknown;
    if (!v || typeof v !== "object") return null;
    const s = v as Partial<StoredPrefs>;
    if (typeof s.userId !== "string" || s.userId !== userId) return null;
    return parseReminderPrefs(s.prefs);
  } catch {
    return null;
  }
}

export function serializePrefsCache(userId: string, prefs: ReminderPrefs): string {
  const stored: StoredPrefs = { userId, prefs };
  return JSON.stringify(stored);
}

// ── Text ───────────────────────────────────────────────────────────────────

/** A wall-clock reading in the org's zone. */
export type WallClock = { h: number; mi: number };

/** "7:00 AM", "12:05 PM", "12:30 AM". No Intl, and a plain space before
 *  AM/PM (newer ICU puts a narrow no-break space there). */
export function formatClock12(w: WallClock): string | null {
  if (
    !Number.isInteger(w.h) ||
    !Number.isInteger(w.mi) ||
    w.h < 0 ||
    w.h > 23 ||
    w.mi < 0 ||
    w.mi > 59
  ) {
    return null;
  }
  const h12 = w.h % 12 === 0 ? 12 : w.h % 12;
  const mm = w.mi < 10 ? `0${w.mi}` : String(w.mi);
  return `${h12}:${mm} ${w.h < 12 ? "AM" : "PM"}`;
}

export function shiftReminderText(clock: string): { title: string; body: string } {
  return {
    title: `Your shift starts at ${clock}.`,
    body: "Open Clox to clock in when you get there.",
  };
}

/** A manager edits a past shift's end time under Recent shifts; anyone else
 *  asks for the change there (RequestEditModal), so the text says which. */
export function longShiftText(
  hours: number,
  isManager: boolean,
): { title: string; body: string } {
  const ago = `You clocked in ${hours} ${hours === 1 ? "hour" : "hours"} ago.`;
  return {
    title: "Still on the clock?",
    body: isManager
      ? `${ago} Clock out now, and if you finished earlier, fix the end time under Recent shifts.`
      : `${ago} Clock out now, and if you finished earlier, tap the shift under Recent shifts to ask for a change to the end time.`,
  };
}

/** ClockScreen's banner when reminders are on (the phone's switches, or web
 *  Settings) but this phone does not allow Clox notifications. */
export const REMINDERS_BLOCKED_COPY =
  "Notifications are off for Clox on this phone, so the switches you turned on under Reminders can't work. Open Reminders in the account menu to allow notifications.";

// ── Identifiers ────────────────────────────────────────────────────────────

/** A short stable hash (djb2, base 36) of a string. */
export function shortHash(s: string): string {
  let h = 5381;
  for (let i = 0; i < s.length; i++) {
    h = ((h << 5) + h + s.charCodeAt(i)) | 0;
  }
  return (h >>> 0).toString(36);
}

/** Identifiers carry only letters, digits and dashes between the dots. */
function safePart(s: string): string {
  return s.replace(/[^A-Za-z0-9-]/g, "_").slice(0, 64);
}

// ── Plans ──────────────────────────────────────────────────────────────────

export type ReminderRequest = {
  identifier: string;
  fireAtMs: number;
  title: string;
  body: string;
  data: Record<string, string>;
};

export type ScheduledShift = { id: string; startsAt: string };

/** True when a shift reminder firing at `fireAtMs` falls inside the hold
 *  window of the running shift (see ON_SHIFT_HOLD_MS). */
function heldByRunningShift(
  fireAtMs: number,
  runningSinceMs: number | null,
): boolean {
  return (
    runningSinceMs !== null &&
    Number.isFinite(runningSinceMs) &&
    fireAtMs < runningSinceMs + ON_SHIFT_HOLD_MS
  );
}

/** The fire time written into one of our identifiers, or null. Both kinds
 *  end in ".<fireAtMs>.<hash>". */
export function fireAtFromId(id: string): number | null {
  const parts = id.split(".");
  if (parts.length < 3) return null;
  const n = Number(parts[parts.length - 2]);
  return Number.isInteger(n) && n > 0 ? n : null;
}

/**
 * The shift reminders that should exist right now. Rules:
 * - the preference is on;
 * - the shift starts in the future, within SHIFT_REMINDER_HORIZON_MS;
 * - its reminder time is still ahead (a shift that has started, or whose
 *   reminder time has passed, gets none);
 * - while a shift is running, none that would fire within ON_SHIFT_HOLD_MS
 *   of that clock-in;
 * - the org wall-clock for its start is known;
 * - one per start time (two schedule rows at the same moment remind once);
 * - the soonest MAX_SHIFT_REMINDERS.
 */
export function shiftReminderCandidates(args: {
  minutes: number | null;
  shifts: ScheduledShift[];
  nowMs: number;
  runningSinceMs: number | null;
  wallClock: (ms: number) => WallClock | null;
}): ReminderRequest[] {
  const { minutes, shifts, nowMs, runningSinceMs, wallClock } = args;
  if (minutes === null || !(minutes > 0)) return [];
  const leadMs = minutes * MINUTE_MS;
  const rows: { id: string; startMs: number }[] = [];
  for (const s of shifts) {
    const startMs = Date.parse(s.startsAt);
    if (!Number.isFinite(startMs) || typeof s.id !== "string" || !s.id) continue;
    if (startMs <= nowMs) continue;
    if (startMs > nowMs + SHIFT_REMINDER_HORIZON_MS) continue;
    if (startMs - leadMs <= nowMs) continue;
    if (heldByRunningShift(startMs - leadMs, runningSinceMs)) continue;
    rows.push({ id: s.id, startMs });
  }
  rows.sort((a, b) => a.startMs - b.startMs || (a.id < b.id ? -1 : 1));
  const out: ReminderRequest[] = [];
  const seenStarts = new Set<number>();
  for (const r of rows) {
    if (out.length >= MAX_SHIFT_REMINDERS) break;
    if (seenStarts.has(r.startMs)) continue;
    const w = wallClock(r.startMs);
    const clock = w ? formatClock12(w) : null;
    if (!clock) continue;
    seenStarts.add(r.startMs);
    const fireAtMs = r.startMs - leadMs;
    const text = shiftReminderText(clock);
    out.push({
      identifier: `${SHIFT_REMINDER_ID_PREFIX}${safePart(r.id)}.${fireAtMs}.${shortHash(text.title + text.body)}`,
      fireAtMs,
      title: text.title,
      body: text.body,
      // startsAt lets the app hold back a reminder that arrives after the
      // shift has started (push.ts): Android 12 and later deliver these
      // alarms late at times (the 1.3.0 build has no exact alarms).
      data: {
        type: SHIFT_REMINDER_TYPE,
        shiftId: r.id,
        startsAt: String(r.startMs),
      },
    });
  }
  return out;
}

/**
 * The long shift reminder that should exist right now, or none: the
 * preference is on, a shift is running, and clock-in plus N hours is still
 * ahead. `runningSinceMs` is the shift's start (the server's startedAt, or
 * the tap time of a clock-in still on this phone).
 */
export function longShiftCandidate(args: {
  hours: number | null;
  runningSinceMs: number | null;
  nowMs: number;
  isManager: boolean;
}): ReminderRequest[] {
  const { hours, runningSinceMs, nowMs, isManager } = args;
  if (hours === null || !(hours > 0)) return [];
  if (runningSinceMs === null || !Number.isFinite(runningSinceMs)) return [];
  const fireAtMs = runningSinceMs + hours * HOUR_MS;
  if (fireAtMs <= nowMs) return [];
  const text = longShiftText(hours, isManager);
  return [
    {
      identifier: `${LONG_SHIFT_ID_PREFIX}${fireAtMs}.${shortHash(text.title + text.body)}`,
      fireAtMs,
      title: text.title,
      body: text.body,
      data: { type: LONG_SHIFT_TYPE },
    },
  ];
}

/**
 * What to change so the scheduled notifications under `prefix` match
 * `wanted`. Only identifiers under `prefix` are ever cancelled, so the other
 * kind of reminder (and anything that is not ours) is never touched. A wanted
 * reminder that is already scheduled is kept even inside MIN_LEAD_MS of
 * firing; a missing one is only scheduled when it is at least MIN_LEAD_MS
 * ahead.
 */
export function planReminderSync(args: {
  prefix: string;
  wanted: ReminderRequest[];
  scheduledIds: string[];
  nowMs: number;
}): { cancel: string[]; schedule: ReminderRequest[] } {
  const { prefix, wanted, scheduledIds, nowMs } = args;
  const wantedIds = new Set(wanted.map((w) => w.identifier));
  const present = new Set(scheduledIds);
  const cancel = Array.from(present).filter(
    (id) => id.startsWith(prefix) && !wantedIds.has(id),
  );
  const schedule = wanted.filter(
    (w) => !present.has(w.identifier) && w.fireAtMs > nowMs + MIN_LEAD_MS,
  );
  return { cancel, schedule };
}

export type ReminderPlan = { cancel: string[]; schedule: ReminderRequest[] };

/**
 * The whole shift reminder decision, including what to do with partial
 * knowledge. `minutes` undefined means the preference is not known on this
 * phone yet (no status this session and nothing cached); `shifts` null means
 * no schedule has loaded this session; `wallClock` null means the org zone is
 * not known.
 * - preference off: cancel every shift reminder (nothing else is needed);
 * - everything known: schedule and cancel to match the rules above;
 * - otherwise nothing new is scheduled and nothing is cancelled, except that
 *   while a shift is running the reminders inside its hold window go (a
 *   clock-in made offline after a cold start still silences the reminder
 *   for the shift it started early).
 */
export function planShiftReminders(args: {
  minutes: number | null | undefined;
  shifts: ScheduledShift[] | null;
  runningSinceMs: number | null;
  wallClock: ((ms: number) => WallClock | null) | null;
  scheduledIds: string[];
  nowMs: number;
}): ReminderPlan {
  const { minutes, shifts, runningSinceMs, wallClock, scheduledIds, nowMs } =
    args;
  const ours = scheduledIds.filter((id) =>
    id.startsWith(SHIFT_REMINDER_ID_PREFIX),
  );
  if (minutes === null) return { cancel: ours, schedule: [] };
  if (minutes === undefined || shifts === null || wallClock === null) {
    const cancel = ours.filter((id) => {
      const at = fireAtFromId(id);
      return at !== null && heldByRunningShift(at, runningSinceMs);
    });
    return { cancel, schedule: [] };
  }
  return planReminderSync({
    prefix: SHIFT_REMINDER_ID_PREFIX,
    wanted: shiftReminderCandidates({
      minutes,
      shifts,
      nowMs,
      runningSinceMs,
      wallClock,
    }),
    scheduledIds,
    nowMs,
  });
}

/**
 * The long shift reminder decision. `hours` undefined means the preference
 * is not known on this phone: with no shift running the reminder is
 * cancelled anyway (a clock-out always silences it), and with one running
 * nothing changes.
 */
export function planLongShiftReminder(args: {
  hours: number | null | undefined;
  runningSinceMs: number | null;
  isManager: boolean;
  scheduledIds: string[];
  nowMs: number;
}): ReminderPlan {
  const { hours, runningSinceMs, isManager, scheduledIds, nowMs } = args;
  if (hours === undefined) {
    if (runningSinceMs !== null) return { cancel: [], schedule: [] };
    return {
      cancel: scheduledIds.filter((id) => id.startsWith(LONG_SHIFT_ID_PREFIX)),
      schedule: [],
    };
  }
  return planReminderSync({
    prefix: LONG_SHIFT_ID_PREFIX,
    wanted: longShiftCandidate({ hours, runningSinceMs, nowMs, isManager }),
    scheduledIds,
    nowMs,
  });
}

/**
 * True for a shift reminder that arrives once its shift has started. Android
 * 12 and later can deliver it late (inexact alarms in the 1.3.0 build); the
 * app holds such a one back while it is in the foreground (push.ts). A
 * reminder without a start time is shown.
 */
export function isLateShiftReminder(data: unknown, nowMs: number): boolean {
  if (!data || typeof data !== "object") return false;
  const d = data as { type?: unknown; startsAt?: unknown };
  if (d.type !== SHIFT_REMINDER_TYPE) return false;
  const startMs = Number(d.startsAt);
  return Number.isFinite(startMs) && startMs > 0 && nowMs >= startMs;
}

// ── Taps ───────────────────────────────────────────────────────────────────

export type TapTarget = "Roster" | "Clock";

/**
 * Where a tapped notification should open. The refused clock-in push opens
 * the Roster, and only for a manager (someone demoted since is left where
 * they are). The two local reminders open the Clock screen. Anything else
 * (the server's "we clocked you out" push, say) opens the app as it is.
 */
export function tapTargetFor(data: unknown, isManager: boolean): TapTarget | null {
  if (!data || typeof data !== "object") return null;
  const type = (data as { type?: unknown }).type;
  if (type === REFUSED_PUNCH_TYPE) return isManager ? "Roster" : null;
  if (type === SHIFT_REMINDER_TYPE || type === LONG_SHIFT_TYPE) return "Clock";
  return null;
}
