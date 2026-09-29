import type { SimplePunchInput, SimplePunchKind } from "./punch-builders";

/**
 * The running shift outside the app: the iOS Live Activity (Lock Screen and
 * Dynamic Island) and small Home Screen widget, and the Android ongoing
 * notification. This file is the contract between the app's JavaScript and
 * the native module that draws them (modules/clox-shift-surface), plus the
 * pure rules for what each surface shows and what a tap turns into.
 *
 * Pure: type imports only, no Intl, no clock reads (every rule takes nowMs),
 * so scripts/shift-surface-check.mjs runs it under plain node. Times are
 * formatted by the caller (the app passes lib/zoned-time's org-zone helpers).
 *
 * One punch path. A surface tap never talks to the server. The native module
 * saves it to the tap inbox and wakes the JavaScript, which turns it into
 * the same queued punch the Clock screen makes (planInbox + buildSimplePunch
 * + queue.ts enqueuePunch), so order, idempotency, the 23 hour hold and the
 * owner rule are the queue's own.
 *
 * ── Shared storage ───────────────────────────────────────────────────────
 * iOS: UserDefaults(suiteName: SURFACE_APP_GROUP). Android: the
 * SharedPreferences file SURFACE_ANDROID_PREFS (MODE_PRIVATE). Each key holds
 * one JSON string. Only the native module writes them; the iOS widget
 * extension only reads. Every blob carries `v`; a reader ignores a blob whose
 * `v` it does not know (the widget then shows its signed-out look, and the
 * module treats it as absent).
 *
 *   SURFACE_KEYS.state      SurfaceStateV1, written by JS through apply().
 *   SURFACE_KEYS.inbox      SurfaceTapV1[], appended by native at a tap and
 *                           trimmed by ackTaps() once JS has queued a tap.
 *   SURFACE_KEYS.dismissal  SurfaceDismissalV1, written by native when the
 *                           person swipes the Live Activity or the
 *                           notification away. iOS: only a change from
 *                           active or stale straight to dismissed, for an
 *                           activity the app did not end, is a swipe; ended
 *                           then dismissed is the system clearing the Lock
 *                           Screen after the 8 hour end. Android: the
 *                           notification's deleteIntent (it does not fire
 *                           when the app cancels it).
 *   SURFACE_KEYS.activity   ActivityRecordV1 (iOS only), written by native
 *                           when it starts, updates or ends an activity.
 *
 * ── What native does at a tap ────────────────────────────────────────────
 *   1. Read the state. Ignore the tap unless tapApplies(state, kind): this is
 *      what stops a double tap (a pending tap blocks the next one), a tap on
 *      a surface left over from another account, and any tap while the
 *      remote off switch is off.
 *   2. Append { v, id: lowercase UUID, kind, tapMs: epoch ms, userId:
 *      state.ownerUserId, projectId: state.projectId, source } to the inbox
 *      with a synchronous write (commit() on Android).
 *   3. Write applyTap(state, tap) as the state, redraw the surface from
 *      surfaceView() (pending), and reload the widget timelines.
 *   4. Wake the JavaScript ("onTap" event, or the Android headless task).
 *   5. iOS only: wait up to about 20 s for signalTap(id, "queued") and then
 *      signalTap(id, "done") before perform() returns. A tap that nothing
 *      answers stays in the inbox and is sent at the next open, with its tap
 *      time.
 */

// ── Contract constants ───────────────────────────────────────────────────

/** Bumped only with a new store build: native and JS of one runtime version
 *  always ship together, and each ignores a version it does not know. */
export const SURFACE_SCHEMA_VERSION = 1 as const;

export const SURFACE_APP_GROUP = "group.com.getclox.clock";
export const SURFACE_ANDROID_PREFS = "clox.shift_surface";

export const SURFACE_KEYS = {
  state: "clox.surface.state",
  inbox: "clox.surface.inbox",
  dismissal: "clox.surface.dismissal",
  activity: "clox.surface.activity",
} as const;

/** Opens the Clock screen and does nothing else. Any app or web page can open
 *  it, so it must never clock anyone in or out by itself. */
export const SURFACE_OPEN_URL = "clox://clock";

/** iOS ends a Live Activity 8 hours after it starts, then leaves it on the
 *  Lock Screen for up to 4 more hours. */
export const ACTIVITY_MAX_MS = 8 * 60 * 60_000;
/** While the app is in the foreground, an activity this old is replaced by a
 *  new one, so a long shift keeps a live timer past the 8 hour end. */
export const ACTIVITY_REPLACE_AFTER_MS = 7.5 * 60 * 60_000;
/** A pending tap with no answer this long after it shows "Open Clox to send
 *  it" (the Live Activity's staleDate). */
export const PENDING_STALE_MS = 2 * 60_000;
/** How long an activity ended by a surface clock-out keeps its final line on
 *  the Lock Screen. A clock-out made inside the app ends it at once. */
export const FINAL_CARD_MS = 15 * 60_000;
/** Two shift starts this close are the same shift: the server keeps a
 *  replayed clock-in's tap time, but a start edited by a few seconds, or
 *  rounded, must not read as a new shift. */
export const SAME_SHIFT_TOLERANCE_MS = 2 * 60_000;
/** Tap ids JS remembers having queued, newest last, so a tap delivered
 *  twice (JS queued it, native never got the ack) is not queued twice after
 *  the first copy has already left the queue. */
export const HANDLED_IDS_CAP = 100;
/** Project and task names are cut to this many characters each. The Live
 *  Activity's whole payload must stay under 4 KB. */
export const MAX_NAME_CHARS = 60;

// ── Types ────────────────────────────────────────────────────────────────

/** "signed_out": nobody is signed in, or the session belongs to nobody the
 *  surfaces may show. "off": signed in, not clocked in. */
export type SurfaceStatus = "off" | "on" | "break" | "signed_out";
export type SurfaceTapKind = SimplePunchKind;
export type SurfaceSource = "live_activity" | "widget" | "notification";
export type ShiftPhase = "on" | "break";

/**
 * Every string a surface shows, carried in the state so an EAS Update can fix
 * wording without a store build. `{time}` is replaced with a clock time in
 * the org's zone ("9:42 AM"). The *Fixed strings are compiled into the
 * native code (the widget gallery and the Android channel settings read them
 * before any state exists); they are listed here so the copy check covers
 * them and the native pass copies them verbatim.
 *
 * Copy rules: complete sentences where there is room, no em or en dashes, no
 * exclamation marks, never the word "tech". The "·" in "Project · Task" is a
 * middle dot (decision 1), not a dash.
 */
export type SurfaceCopy = {
  onEyebrow: string;
  breakEyebrow: string;
  clockingOutEyebrow: string;
  started: string;
  breakShiftSince: string;
  takeBreak: string;
  endBreak: string;
  clockOut: string;
  clockIn: string;
  takeBreakA11y: string;
  endBreakA11y: string;
  clockOutA11y: string;
  clockOutOpensA11y: string;
  clockInA11y: string;
  notClockedIn: string;
  openToSignIn: string;
  openToSee: string;
  pendingOut: string;
  pendingBreakStart: string;
  pendingBreakEnd: string;
  stale: string;
  clockedOutAt: string;
  clockedOut: string;
  savedOffline: string;
  refusedOut: string;
  refusedBreakStart: string;
  refusedBreakEnd: string;
  notificationOnTitle: string;
  notificationBreakTitle: string;
  notificationClockingOutTitle: string;
  widgetNameFixed: string;
  widgetDescriptionFixed: string;
  channelNameFixed: string;
  channelDescriptionFixed: string;
};

export const SURFACE_COPY: SurfaceCopy = {
  onEyebrow: "ON THE CLOCK",
  breakEyebrow: "ON BREAK",
  clockingOutEyebrow: "CLOCKING OUT",
  started: "Started {time}",
  breakShiftSince: "Your shift started at {time}.",
  takeBreak: "Take break",
  endBreak: "End break",
  clockOut: "Clock out",
  clockIn: "Clock in",
  takeBreakA11y: "Take a break.",
  endBreakA11y: "End your break.",
  clockOutA11y: "Clock out.",
  clockOutOpensA11y: "Clock out. Opens Clox so you can finish it there.",
  clockInA11y: "Clock in. Opens Clox.",
  notClockedIn: "You're not clocked in.",
  openToSignIn: "Open Clox to sign in.",
  openToSee: "Open Clox to see your shift.",
  pendingOut: "Sending your clock-out.",
  pendingBreakStart: "Starting your break.",
  pendingBreakEnd: "Ending your break.",
  stale: "Open Clox to send it.",
  clockedOutAt: "Clocked out at {time}.",
  clockedOut: "You're clocked out.",
  savedOffline: "Saved on this phone. It sends when you're online.",
  refusedOut: "Clock-out didn't go through. Open Clox.",
  refusedBreakStart: "Your break didn't start. Open Clox.",
  refusedBreakEnd: "Your break didn't end. Open Clox.",
  notificationOnTitle: "On the clock",
  notificationBreakTitle: "On break",
  notificationClockingOutTitle: "Clocking out",
  widgetNameFixed: "Clox",
  widgetDescriptionFixed: "See your running shift and clock out from here.",
  channelNameFixed: "Running shift",
  channelDescriptionFixed:
    "Shows your running shift and its timer while you're on the clock.",
};

/** Copy the app itself shows (not a surface), kept here so one check covers
 *  every string of the feature. */
export const SURFACE_APP_COPY = {
  /** Android only, once, at the first clock-in (decision 4). The system
   *  dialog cannot be worded, so this in-app question comes first. */
  askTitle: "Show your shift on the lock screen?",
  askMessage:
    "Allow notifications so your running shift and its Clock out button show on the lock screen.",
  askAllow: "Allow",
  askSettings: "Open Settings",
  askNotNow: "Not now",
  /** A saved tap that belonged to another account, dropped unsent. */
  otherAccountTap:
    "A lock screen tap from another account was not sent. Check your shift.",
} as const;

/**
 * What the surfaces show. JS builds it (buildSurfaceState) and hands it to
 * native; native changes only `pendingTap` (at a tap, via applyTap).
 */
export type SurfaceStateV1 = {
  v: 1;
  /** The remote off switch (shift-surface.ts SHIFT_SURFACES_ENABLED). False
   *  ends every Live Activity and the notification, turns the widget into a
   *  plain "Open Clox" link, and makes native ignore taps. */
  enabled: boolean;
  status: SurfaceStatus;
  /** The signed-in user this state belongs to. Every tap is stamped with it,
   *  and JS never queues a tap for anyone else. */
  ownerUserId: string | null;
  /** Epoch ms the running shift started (the shift anchor, not a segment
   *  start after a project switch). Set when status is "on" or "break". */
  shiftStartMs: number | null;
  /** Epoch ms the current break started. Set when status is "break". */
  breakStartMs: number | null;
  /** The running shift's project, stamped into a clock-out tap. */
  projectId: string | null;
  /** "Project · Task", "Project", or null (decision 1). */
  label: string | null;
  /** The shift start as a clock time in the org's zone, "9:42 AM". */
  startedAtText: string | null;
  /** The org's IANA zone, for native code that formats a time itself. */
  orgTimeZone: string | null;
  /** The org needs a project to clock out and the shift has none: Clock out
   *  opens the app instead of sending a punch the server would refuse. */
  needsProjectToClockOut: boolean;
  /** A tap saved on this phone that JS has not answered yet. */
  pendingTap: { id: string; kind: SurfaceTapKind; tapMs: number } | null;
  /** The last tap was refused by the server. Shown in place of the start
   *  line until the next state from the app. */
  notice: { kind: SurfaceTapKind; text: string } | null;
  copy: SurfaceCopy;
  updatedMs: number;
};

/** One saved tap in the inbox. */
export type SurfaceTapV1 = {
  v: 1;
  /** Lowercase UUID, also the punch id and the server's idempotency key. */
  id: string;
  kind: SurfaceTapKind;
  /** Epoch ms of the tap. The punch's clientTime. */
  tapMs: number;
  /** state.ownerUserId at the moment of the tap. */
  userId: string;
  /** state.projectId at the moment of the tap. */
  projectId: string | null;
  source: SurfaceSource;
};

/** The person swiped the Live Activity (iOS) or the notification (Android)
 *  away. It stays away for this shift and phase; the next shift, or a break
 *  starting or ending, shows it again. */
export type SurfaceDismissalV1 = {
  v: 1;
  surface: "live_activity" | "notification";
  shiftStartMs: number;
  phase: ShiftPhase;
  atMs: number;
};

/** iOS: the activity the app started most recently. Native keeps `phase`
 *  current on every update and sets `endedByApp` when the app ends it. */
export type ActivityRecordV1 = {
  v: 1;
  activityId: string;
  shiftStartMs: number;
  phase: ShiftPhase;
  /** When this activity started (ActivityKit ends it 8 hours later). */
  createdMs: number;
  endedByApp: boolean;
};

/** iOS: one entry of Activity<ShiftAttributes>.activities. */
export type ActivityInfo = {
  id: string;
  shiftStartMs: number;
  createdMs: number;
  state: "active" | "stale" | "ended" | "dismissed";
};

/** Everything native knows, read in one call before JS decides. */
export type NativeSnapshot = {
  schemaVersion: number;
  platform: "ios" | "android" | "none";
  /** iOS 16.2 or later with ActivityKit; always false on Android. */
  activitiesSupported: boolean;
  /** ActivityAuthorizationInfo().areActivitiesEnabled. */
  activitiesEnabled: boolean;
  /** Android: the app may post notifications (13+ permission and channel). */
  notificationsAllowed: boolean;
  /** Android: the running-shift notification is showing. */
  notificationShown: boolean;
  activities: ActivityInfo[];
  activityRecord: ActivityRecordV1 | null;
  dismissal: SurfaceDismissalV1 | null;
  state: SurfaceStateV1 | null;
};

export const EMPTY_SNAPSHOT: NativeSnapshot = {
  schemaVersion: SURFACE_SCHEMA_VERSION,
  platform: "none",
  activitiesSupported: false,
  activitiesEnabled: false,
  notificationsAllowed: false,
  notificationShown: false,
  activities: [],
  activityRecord: null,
  dismissal: null,
  state: null,
};

// ── Small helpers ────────────────────────────────────────────────────────

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const TAP_KINDS: readonly SurfaceTapKind[] = ["out", "break_start", "break_end"];
const SOURCES: readonly SurfaceSource[] = [
  "live_activity",
  "widget",
  "notification",
];

function isObj(x: unknown): x is Record<string, unknown> {
  return typeof x === "object" && x !== null && !Array.isArray(x);
}

function finite(x: unknown): x is number {
  return typeof x === "number" && Number.isFinite(x);
}

function strOrNull(x: unknown): string | null {
  return typeof x === "string" && x.length > 0 ? x : null;
}

function cut(name: string, max: number): string {
  const t = name.trim().replace(/\s+/g, " ");
  if (t.length <= max) return t;
  return `${t.slice(0, max - 1).trimEnd()}…`;
}

/** Fill a copy template. A missing time leaves the line out (null). */
export function fillTime(template: string, time: string | null): string | null {
  if (!template.includes("{time}")) return template;
  if (!time) return null;
  return template.split("{time}").join(time);
}

/** Parse JSON from native, never throwing. */
export function safeJson(text: string | null | undefined): unknown {
  if (typeof text !== "string" || text.length === 0) return null;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return null;
  }
}

export function sameShift(a: number | null, b: number | null): boolean {
  if (!finite(a) || !finite(b)) return false;
  return Math.abs(a - b) <= SAME_SHIFT_TOLERANCE_MS;
}

/** "Project · Task" (decision 1), "Project", or null. A task never shows
 *  without its project. */
export function projectTaskLabel(
  projectName: string | null | undefined,
  taskName: string | null | undefined,
): string | null {
  const p = projectName && projectName.trim() ? cut(projectName, MAX_NAME_CHARS) : null;
  if (!p) return null;
  const t = taskName && taskName.trim() ? cut(taskName, MAX_NAME_CHARS) : null;
  return t ? `${p} · ${t}` : p;
}

// ── Building the state ───────────────────────────────────────────────────

export type SurfaceInput = {
  /** SHIFT_SURFACES_ENABLED at the moment of the push. */
  enabled: boolean;
  /** The signed-in user, or null when nobody is signed in. */
  userId: string | null;
  shiftStartMs: number | null;
  breakStartMs: number | null;
  projectId: string | null;
  projectName: string | null;
  taskName: string | null;
  /** /status organization.requireProject. */
  requireProject: boolean;
  orgTimeZone: string | null;
};

/**
 * The state for what the app knows now. `formatClock` gives a clock time in
 * the org's zone ("9:42 AM"); the app passes zoned-time's clockInZone with
 * the org zone. A state built here has no pending tap and no notice: the
 * app's own view replaces both (see carryPendingTap for a push that must
 * keep a tap native is still waiting on).
 */
export function buildSurfaceState(
  input: SurfaceInput,
  nowMs: number,
  formatClock: (ms: number) => string,
): SurfaceStateV1 {
  const base: SurfaceStateV1 = {
    v: SURFACE_SCHEMA_VERSION,
    enabled: input.enabled,
    status: "signed_out",
    ownerUserId: null,
    shiftStartMs: null,
    breakStartMs: null,
    projectId: null,
    label: null,
    startedAtText: null,
    orgTimeZone: strOrNull(input.orgTimeZone),
    needsProjectToClockOut: false,
    pendingTap: null,
    notice: null,
    copy: SURFACE_COPY,
    updatedMs: nowMs,
  };
  const userId = strOrNull(input.userId);
  if (!userId) return base;
  if (!finite(input.shiftStartMs)) {
    return { ...base, status: "off", ownerUserId: userId };
  }
  const onBreak = finite(input.breakStartMs);
  const projectId = strOrNull(input.projectId);
  return {
    ...base,
    status: onBreak ? "break" : "on",
    ownerUserId: userId,
    shiftStartMs: input.shiftStartMs,
    breakStartMs: onBreak ? (input.breakStartMs as number) : null,
    projectId,
    label: projectTaskLabel(input.projectName, input.taskName),
    startedAtText: formatClock(input.shiftStartMs),
    needsProjectToClockOut: input.requireProject && !projectId,
  };
}

/**
 * Keep a tap native is still waiting on when the app pushes a new state for
 * the same person and shift: the push must not clear the pending look while
 * the tap sits in the inbox. Anything else (another user, another shift, the
 * tap already answered) takes the new state as it is.
 */
export function carryPendingTap(
  prev: SurfaceStateV1 | null,
  next: SurfaceStateV1,
  inboxIds: readonly string[],
): SurfaceStateV1 {
  const tap = prev?.pendingTap;
  if (!prev || !tap) return next;
  if (!inboxIds.includes(tap.id)) return next;
  if (prev.ownerUserId !== next.ownerUserId) return next;
  if (next.status !== "on" && next.status !== "break") return next;
  if (!sameShift(prev.shiftStartMs, next.shiftStartMs)) return next;
  return { ...next, pendingTap: tap };
}

// ── What each surface shows ──────────────────────────────────────────────

export type SurfaceButton = {
  /** A tap kind runs the button's intent or action; "open" opens
   *  SURFACE_OPEN_URL and nothing else. */
  kind: SurfaceTapKind | "open";
  label: string;
  a11y: string;
};

export type Timer = {
  /** The timer counts up from here. */
  startMs: number;
  /** Stopped at this time (a pending clock-out), or null to keep running. */
  pausedAtMs: number | null;
};

export type LiveActivityView =
  | { show: false }
  | {
      show: true;
      phase: ShiftPhase;
      eyebrow: string;
      timer: Timer;
      /** "Project · Task". */
      line2: string | null;
      /** "Started 9:42 AM", a pending line, or a refusal notice. */
      line3: string | null;
      /** Lock Screen and expanded Dynamic Island only. The Watch, CarPlay
       *  and Mac layout is timer-only and never shows buttons (decision 7). */
      buttons: SurfaceButton[];
      /** ActivityKit staleDate, with the line it then shows. */
      staleAtMs: number | null;
      staleText: string | null;
    };

export type WidgetView = {
  mode: "on" | "break" | "pending" | "off" | "signed_out" | "disabled";
  eyebrow: string | null;
  timer: Timer | null;
  /** Running: a refusal notice, else "Project · Task". The small widget has
   *  room for one line of copy under its timer (it may wrap to two), so a
   *  notice takes the label's place there; with neither, it shows line3. */
  line2: string | null;
  line3: string | null;
  /** The widget's one button. In the off mode it is Clock in, which only
   *  opens the app (decision 2): the geofence, project and selfie checks
   *  run there. Everywhere else the whole widget opens the app. */
  button: SurfaceButton | null;
  openUrl: string;
};

export type NotificationView =
  | { show: false }
  | {
      show: true;
      title: string;
      text: string | null;
      subText: string | null;
      /** setUsesChronometer + setWhen, or null for no running timer. */
      chronometerBaseMs: number | null;
      /** Take break or End break, then Clock out. Never "open": tapping the
       *  notification itself opens the app. */
      actions: SurfaceButton[];
      openUrl: string;
    };

export type SurfaceView = {
  activity: LiveActivityView;
  widget: WidgetView;
  notification: NotificationView;
};

/** The shift is running and belongs to someone: the only case anything
 *  shows on the Lock Screen or in the notification shade. */
export function isShiftShown(state: SurfaceStateV1 | null): boolean {
  return (
    !!state &&
    state.v === SURFACE_SCHEMA_VERSION &&
    state.enabled &&
    !!state.ownerUserId &&
    (state.status === "on" || state.status === "break") &&
    finite(state.shiftStartMs)
  );
}

export function phaseOf(state: SurfaceStateV1): ShiftPhase {
  return state.status === "break" ? "break" : "on";
}

/**
 * What every surface shows for a state. Native draws exactly this (the
 * Swift and Kotlin mirror it), so this function is the spec for both.
 */
export function surfaceView(
  state: SurfaceStateV1 | null,
  nowMs: number,
): SurfaceView {
  const copy = state?.copy ?? SURFACE_COPY;
  const hidden = { show: false } as const;
  const widgetBase = {
    eyebrow: null,
    timer: null,
    line2: null,
    line3: null,
    button: null,
    openUrl: SURFACE_OPEN_URL,
  };

  if (!state || state.v !== SURFACE_SCHEMA_VERSION) {
    return {
      activity: hidden,
      notification: hidden,
      widget: { ...widgetBase, mode: "signed_out", line3: copy.openToSignIn },
    };
  }
  if (!state.enabled) {
    return {
      activity: hidden,
      notification: hidden,
      widget: { ...widgetBase, mode: "disabled", line3: copy.openToSee },
    };
  }
  if (state.status === "signed_out" || !state.ownerUserId) {
    return {
      activity: hidden,
      notification: hidden,
      widget: { ...widgetBase, mode: "signed_out", line3: copy.openToSignIn },
    };
  }
  if (!isShiftShown(state)) {
    return {
      activity: hidden,
      notification: hidden,
      widget: {
        ...widgetBase,
        mode: "off",
        line3: copy.notClockedIn,
        button: { kind: "open", label: copy.clockIn, a11y: copy.clockInA11y },
      },
    };
  }

  const shiftStart = state.shiftStartMs as number;
  const onBreak = state.status === "break";
  const breakStart = onBreak && finite(state.breakStartMs) ? state.breakStartMs : shiftStart;
  const startedLine = onBreak
    ? fillTime(copy.breakShiftSince, state.startedAtText)
    : fillTime(copy.started, state.startedAtText);
  const tap = state.pendingTap;

  if (tap) {
    const staleAtMs = tap.tapMs + PENDING_STALE_MS;
    const stale = nowMs >= staleAtMs;
    let phase: ShiftPhase;
    let eyebrow: string;
    let timer: Timer;
    let pendingLine: string;
    let title: string;
    let chronometerBaseMs: number | null;
    if (tap.kind === "out") {
      phase = onBreak ? "break" : "on";
      eyebrow = copy.clockingOutEyebrow;
      // The whole shift, stopped at the tap: what the clock-out records.
      timer = { startMs: shiftStart, pausedAtMs: tap.tapMs };
      pendingLine = copy.pendingOut;
      title = copy.notificationClockingOutTitle;
      chronometerBaseMs = null;
    } else if (tap.kind === "break_start") {
      phase = "break";
      eyebrow = copy.breakEyebrow;
      timer = { startMs: tap.tapMs, pausedAtMs: null };
      pendingLine = copy.pendingBreakStart;
      title = copy.notificationBreakTitle;
      chronometerBaseMs = tap.tapMs;
    } else {
      phase = "on";
      eyebrow = copy.onEyebrow;
      timer = { startMs: shiftStart, pausedAtMs: null };
      pendingLine = copy.pendingBreakEnd;
      title = copy.notificationOnTitle;
      chronometerBaseMs = shiftStart;
    }
    const line3 = stale ? copy.stale : pendingLine;
    return {
      activity: {
        show: true,
        phase,
        eyebrow,
        timer,
        line2: state.label,
        line3,
        buttons: [],
        staleAtMs,
        staleText: copy.stale,
      },
      widget: {
        mode: "pending",
        eyebrow,
        timer,
        line2: state.label,
        line3,
        button: null,
        openUrl: SURFACE_OPEN_URL,
      },
      notification: {
        show: true,
        title,
        text: line3,
        subText: state.label,
        chronometerBaseMs,
        actions: [],
        openUrl: SURFACE_OPEN_URL,
      },
    };
  }

  const clockOutOpens =
    state.needsProjectToClockOut || state.notice?.kind === "out";
  const clockOut: SurfaceButton = clockOutOpens
    ? { kind: "open", label: copy.clockOut, a11y: copy.clockOutOpensA11y }
    : { kind: "out", label: copy.clockOut, a11y: copy.clockOutA11y };
  const breakButton: SurfaceButton = onBreak
    ? { kind: "break_end", label: copy.endBreak, a11y: copy.endBreakA11y }
    : { kind: "break_start", label: copy.takeBreak, a11y: copy.takeBreakA11y };
  const timer: Timer = { startMs: onBreak ? breakStart : shiftStart, pausedAtMs: null };
  const eyebrow = onBreak ? copy.breakEyebrow : copy.onEyebrow;
  const line3 = state.notice?.text ?? startedLine;

  return {
    activity: {
      show: true,
      phase: onBreak ? "break" : "on",
      eyebrow,
      timer,
      line2: state.label,
      line3,
      buttons: [breakButton, clockOut],
      staleAtMs: null,
      staleText: null,
    },
    widget: {
      mode: onBreak ? "break" : "on",
      eyebrow,
      timer,
      line2: state.notice?.text ?? state.label,
      line3,
      // The small widget has room for one button.
      button: clockOut,
      openUrl: SURFACE_OPEN_URL,
    },
    notification: {
      show: true,
      title: onBreak ? copy.notificationBreakTitle : copy.notificationOnTitle,
      // Android draws subText in the one-line header, next to "Clox" and
      // the timer, where a long line is cut off. A refusal notice is the
      // line that matters, so it takes the body and the label moves up.
      text: state.notice?.text ?? state.label ?? startedLine,
      subText: state.notice ? state.label : state.label ? startedLine : null,
      chronometerBaseMs: timer.startMs,
      // A clock-out that has to open the app is left off the notification:
      // an action that only opens the app is what tapping it already does.
      actions: clockOutOpens ? [breakButton] : [breakButton, clockOut],
      openUrl: SURFACE_OPEN_URL,
    },
  };
}

// ── Taps (native mirrors these) ──────────────────────────────────────────

/** Whether a tap of `kind` may be saved right now. */
export function tapApplies(
  state: SurfaceStateV1 | null,
  kind: SurfaceTapKind,
): boolean {
  if (!isShiftShown(state) || !state) return false;
  if (state.pendingTap) return false;
  if (kind === "break_start") return state.status === "on";
  if (kind === "break_end") return state.status === "break";
  return !state.needsProjectToClockOut && state.notice?.kind !== "out";
}

/** The state right after a tap is saved: pending, notice cleared. */
export function applyTap(
  state: SurfaceStateV1,
  tap: Pick<SurfaceTapV1, "id" | "kind" | "tapMs">,
  nowMs: number,
): SurfaceStateV1 {
  return {
    ...state,
    pendingTap: { id: tap.id, kind: tap.kind, tapMs: tap.tapMs },
    notice: null,
    updatedMs: nowMs,
  };
}

/**
 * How a saved tap ended up, as JS learns it:
 *   sent      the server took it (2xx, or 409 for a punch it already has)
 *   queued    saved in the punch queue, not sent yet (offline, or held)
 *   refused   the server refused it (a 4xx the queue dropped)
 *   not_sent  never queued: it belonged to another account, or was malformed
 */
export type TapOutcome = "sent" | "queued" | "refused" | "not_sent";

export type OutcomeResult = {
  state: SurfaceStateV1;
  /** The shift ended from a surface: iOS ends the Live Activity with this
   *  final line, left on the Lock Screen until dismissAtMs; Android replaces
   *  the ongoing notification with a plain one that times out then. Null
   *  leaves both to planActivity and planNotification. */
  finalCard: { text: string; dismissAtMs: number } | null;
};

/**
 * The state after a tap's outcome. `formatClock` formats in the org's zone,
 * as for buildSurfaceState.
 */
export function applyTapOutcome(
  state: SurfaceStateV1,
  tap: Pick<SurfaceTapV1, "id" | "kind" | "tapMs">,
  outcome: TapOutcome,
  nowMs: number,
  formatClock: (ms: number) => string,
): OutcomeResult {
  const copy = state.copy ?? SURFACE_COPY;
  const cleared: SurfaceStateV1 = {
    ...state,
    pendingTap: state.pendingTap?.id === tap.id ? null : state.pendingTap,
    updatedMs: nowMs,
  };
  if (outcome === "not_sent") return { state: cleared, finalCard: null };
  const running = cleared.status === "on" || cleared.status === "break";

  if (outcome === "refused") {
    const text =
      tap.kind === "out"
        ? copy.refusedOut
        : tap.kind === "break_start"
          ? copy.refusedBreakStart
          : copy.refusedBreakEnd;
    return {
      state: running ? { ...cleared, notice: { kind: tap.kind, text } } : cleared,
      finalCard: null,
    };
  }

  // sent or queued: the punch stands, on the server or in the queue.
  if (tap.kind === "out") {
    const text =
      outcome === "sent"
        ? (fillTime(copy.clockedOutAt, formatClock(tap.tapMs)) ?? copy.clockedOut)
        : copy.savedOffline;
    return {
      state: {
        ...cleared,
        status: cleared.ownerUserId ? "off" : "signed_out",
        shiftStartMs: null,
        breakStartMs: null,
        projectId: null,
        label: null,
        startedAtText: null,
        needsProjectToClockOut: false,
        pendingTap: null,
        notice: null,
      },
      finalCard: { text, dismissAtMs: nowMs + FINAL_CARD_MS },
    };
  }
  if (!running) return { state: cleared, finalCard: null };
  if (tap.kind === "break_start") {
    return {
      state: { ...cleared, status: "break", breakStartMs: tap.tapMs, notice: null },
      finalCard: null,
    };
  }
  return {
    state: { ...cleared, status: "on", breakStartMs: null, notice: null },
    finalCard: null,
  };
}

// ── The tap inbox → queued punches ───────────────────────────────────────

export function parseTap(raw: unknown): SurfaceTapV1 | null {
  if (!isObj(raw) || raw.v !== SURFACE_SCHEMA_VERSION) return null;
  const id = typeof raw.id === "string" ? raw.id.toLowerCase() : "";
  if (!UUID_RE.test(id)) return null;
  if (!TAP_KINDS.includes(raw.kind as SurfaceTapKind)) return null;
  if (!finite(raw.tapMs) || raw.tapMs <= 0) return null;
  const userId = strOrNull(raw.userId);
  if (!userId) return null;
  const projectId = raw.projectId === null ? null : strOrNull(raw.projectId);
  if (raw.projectId !== null && raw.projectId !== undefined && !projectId) {
    return null;
  }
  const source = SOURCES.includes(raw.source as SurfaceSource)
    ? (raw.source as SurfaceSource)
    : "live_activity";
  return {
    v: SURFACE_SCHEMA_VERSION,
    id,
    kind: raw.kind as SurfaceTapKind,
    tapMs: raw.tapMs,
    userId,
    projectId,
    source,
  };
}

/** Who is signed in, as far as JS can tell. "unknown" is a session that
 *  could not be read (a Keychain read before first unlock, a storage error):
 *  it is not the same as signed out, and taps wait for it. */
export type SessionView =
  | { kind: "user"; userId: string }
  | { kind: "signed_out" }
  | { kind: "unknown" };

export type InboxInput = {
  /** The inbox as native returned it, not yet trusted. */
  taps: readonly unknown[];
  session: SessionView;
  /** queue.ts getQueueOwner and storedPunchCount, and the ids in the queue. */
  queue: { owner: string | null; storedCount: number; ids: readonly string[] };
  /** Tap ids already queued by an earlier pass, newest last. */
  handledIds: readonly string[];
};

export type InboxDecision =
  /** Queue this punch (buildSimplePunch(kind, input) + enqueuePunch), then
   *  ack the tap. */
  | { action: "enqueue"; tap: SurfaceTapV1; punch: { kind: SurfaceTapKind; input: SimplePunchInput } }
  /** Already queued once: ack it and do nothing else. */
  | { action: "ack"; id: string; reason: "already_queued" | "already_handled" }
  /** Never sent: ack it, and for another account tell the person. */
  | { action: "drop"; id: string | null; reason: "other_user" | "malformed" }
  /** Leave it in the inbox for a later pass. */
  | { action: "keep"; id: string; reason: "session_unknown" | "signed_out" | "queue_owned_by_other" };

export type InboxPlan = {
  decisions: InboxDecision[];
  /** handledIds with this pass's enqueues added, capped. Save it only after
   *  the enqueues succeed. */
  handledIds: string[];
};

/**
 * Turn saved taps into queued punches, oldest tap first, at most once each.
 *
 * The owner rule: a tap is queued only for the signed-in user it was saved
 * under. A session that cannot be read, or nobody signed in yet (the lock's
 * re-auth path keeps taps, as it keeps the queue), keeps the tap for later.
 * A different signed-in user drops it. A queue still holding another
 * account's punches (the sign-in guard in App.tsx has not cleared it yet)
 * keeps the tap too, so it never drains under the wrong token.
 *
 * Idempotency: a tap id already in the queue, or queued by an earlier pass,
 * is acked without a second enqueue; the server would dedupe a second copy by
 * its idempotency key anyway, but this keeps the queue clean.
 */
export function planInbox(input: InboxInput): InboxPlan {
  const queued = new Set(input.queue.ids.map((id) => id.toLowerCase()));
  const handled = input.handledIds.map((id) => id.toLowerCase());
  const seen = new Set(handled);
  const decisions: InboxDecision[] = [];

  const parsed: SurfaceTapV1[] = [];
  for (const raw of input.taps) {
    const tap = parseTap(raw);
    if (tap) {
      parsed.push(tap);
    } else {
      const rawId = isObj(raw) && typeof raw.id === "string" ? raw.id.toLowerCase() : null;
      decisions.push({ action: "drop", id: rawId, reason: "malformed" });
    }
  }
  parsed.sort((a, b) => a.tapMs - b.tapMs || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));

  const added: string[] = [];
  for (const tap of parsed) {
    if (queued.has(tap.id)) {
      decisions.push({ action: "ack", id: tap.id, reason: "already_queued" });
      continue;
    }
    if (seen.has(tap.id)) {
      decisions.push({ action: "ack", id: tap.id, reason: "already_handled" });
      continue;
    }
    if (input.session.kind === "unknown") {
      decisions.push({ action: "keep", id: tap.id, reason: "session_unknown" });
      continue;
    }
    if (input.session.kind === "signed_out") {
      decisions.push({ action: "keep", id: tap.id, reason: "signed_out" });
      continue;
    }
    if (input.session.userId !== tap.userId) {
      decisions.push({ action: "drop", id: tap.id, reason: "other_user" });
      continue;
    }
    if (
      input.queue.storedCount > 0 &&
      input.queue.owner !== null &&
      input.queue.owner !== tap.userId
    ) {
      decisions.push({ action: "keep", id: tap.id, reason: "queue_owned_by_other" });
      continue;
    }
    seen.add(tap.id);
    added.push(tap.id);
    decisions.push({
      action: "enqueue",
      tap,
      punch: {
        kind: tap.kind,
        input: {
          id: tap.id,
          clientTime: new Date(tap.tapMs).toISOString(),
          projectId: tap.kind === "out" ? tap.projectId : null,
        },
      },
    });
  }

  return {
    decisions,
    handledIds: [...handled, ...added].slice(-HANDLED_IDS_CAP),
  };
}

// ── Dismissal and the Live Activity lifecycle ────────────────────────────

export function isDismissed(
  dismissal: SurfaceDismissalV1 | null,
  shiftStartMs: number | null,
  phase: ShiftPhase,
): boolean {
  if (!dismissal || dismissal.v !== SURFACE_SCHEMA_VERSION) return false;
  return dismissal.phase === phase && sameShift(dismissal.shiftStartMs, shiftStartMs);
}

export type ActivityContext = {
  state: SurfaceStateV1 | null;
  activities: readonly ActivityInfo[];
  record: ActivityRecordV1 | null;
  dismissal: SurfaceDismissalV1 | null;
  nowMs: number;
  /** An activity can start only while the app is in the foreground (or from
   *  a LiveActivityIntent, which never starts one here). */
  foreground: boolean;
  activitiesEnabled: boolean;
};

export type ActivityPlan = {
  /** End these at once (dismissal policy immediate). */
  endNow: string[];
  /** Update this one with surfaceView(state).activity. */
  update: string | null;
  /** Start a new one with surfaceView(state).activity, after endNow. */
  start: boolean;
  /** Save this dismissal: the activity was swiped away while the app was
   *  not running to see it happen. */
  recordDismissal: SurfaceDismissalV1 | null;
};

/**
 * Which Live Activities to end, update or start.
 *
 * - Nothing shows (clocked out, signed out, off switch): end every activity,
 *   including one the system ended at 8 hours that still sits on the Lock
 *   Screen.
 * - The running shift's own activity is live: update it, or replace it once
 *   it is ACTIVITY_REPLACE_AFTER_MS old and the app is in the foreground, so
 *   a long shift keeps a live timer past the system's 8 hour end.
 * - Any other activity (an earlier shift's, or one the system already ended)
 *   ends at once; a replacement never leaves the old card up.
 * - No live activity for this shift: start one, but only in the foreground,
 *   with activities allowed, with no tap pending, and not after the person
 *   swiped it away for this shift and phase. A swipe the app missed (it was
 *   not running) shows up as the activity it started being gone before the
 *   8 hour end; that counts as a dismissal. Gone after 8 hours is the
 *   system's end, and a new one starts.
 */
export function planActivity(ctx: ActivityContext): ActivityPlan {
  const plan: ActivityPlan = { endNow: [], update: null, start: false, recordDismissal: null };
  const state = ctx.state;
  const live = ctx.activities.filter((a) => a.state === "active" || a.state === "stale");
  const lingering = ctx.activities.filter((a) => a.state === "ended");

  if (!isShiftShown(state) || !state) {
    plan.endNow = [...live, ...lingering].map((a) => a.id);
    return plan;
  }

  const shiftStart = state.shiftStartMs as number;
  const phase = phaseOf(state);
  const pending = !!state.pendingTap;
  const mine = live
    .filter((a) => sameShift(a.shiftStartMs, shiftStart))
    .sort((a, b) => b.createdMs - a.createdMs);
  const keep = mine[0] ?? null;
  plan.endNow = [...live, ...lingering]
    .filter((a) => a.id !== keep?.id)
    .map((a) => a.id);

  const canStart = ctx.foreground && ctx.activitiesEnabled && !pending;

  if (keep) {
    if (canStart && ctx.nowMs - keep.createdMs >= ACTIVITY_REPLACE_AFTER_MS) {
      plan.endNow.push(keep.id);
      plan.start = true;
    } else {
      plan.update = keep.id;
    }
    return plan;
  }

  if (isDismissed(ctx.dismissal, shiftStart, phase)) return plan;

  const rec = ctx.record;
  if (
    rec &&
    rec.v === SURFACE_SCHEMA_VERSION &&
    !rec.endedByApp &&
    rec.phase === phase &&
    sameShift(rec.shiftStartMs, shiftStart) &&
    !ctx.activities.some((a) => a.id === rec.activityId && a.state !== "dismissed") &&
    ctx.nowMs - rec.createdMs < ACTIVITY_MAX_MS
  ) {
    plan.recordDismissal = {
      v: SURFACE_SCHEMA_VERSION,
      surface: "live_activity",
      shiftStartMs: shiftStart,
      phase,
      atMs: ctx.nowMs,
    };
    return plan;
  }

  plan.start = canStart;
  return plan;
}

/**
 * Android: post (or update) the running-shift notification, cancel it, or
 * leave it alone. Posting again with the same id updates it in place. A
 * notification the person swiped away stays away for this shift and phase.
 */
export function planNotification(input: {
  state: SurfaceStateV1 | null;
  dismissal: SurfaceDismissalV1 | null;
  shown: boolean;
  allowed: boolean;
}): { post: boolean; cancel: boolean } {
  const state = input.state;
  if (!isShiftShown(state) || !state) {
    return { post: false, cancel: input.shown };
  }
  if (isDismissed(input.dismissal, state.shiftStartMs, phaseOf(state))) {
    return { post: false, cancel: false };
  }
  return { post: input.allowed, cancel: false };
}

/**
 * Android, at a clock-in (decision 4): whether to ask once more for
 * notification permission, for someone who declined at sign-in. At most once
 * per install (the caller saves `askedBefore` as soon as it asks), never on
 * iOS (a Live Activity needs no notification permission), never while the
 * off switch is off. "settings" is for a phone that will not show the system
 * prompt again: the question then offers Open Settings instead of Allow.
 */
export function planNotificationAsk(input: {
  platform: string;
  enabled: boolean;
  granted: boolean;
  canAskAgain: boolean;
  askedBefore: boolean;
}): "none" | "ask" | "settings" {
  if (input.platform !== "android" || !input.enabled) return "none";
  if (input.granted || input.askedBefore) return "none";
  return input.canAskAgain ? "ask" : "settings";
}

// ── Reading native's blobs ───────────────────────────────────────────────

export function parseState(raw: unknown): SurfaceStateV1 | null {
  if (!isObj(raw) || raw.v !== SURFACE_SCHEMA_VERSION) return null;
  const status = raw.status;
  if (status !== "off" && status !== "on" && status !== "break" && status !== "signed_out") {
    return null;
  }
  const copy: SurfaceCopy = { ...SURFACE_COPY };
  if (isObj(raw.copy)) {
    for (const key of Object.keys(SURFACE_COPY) as (keyof SurfaceCopy)[]) {
      const value = raw.copy[key];
      if (typeof value === "string" && value.length > 0) copy[key] = value;
    }
  }
  const pt = raw.pendingTap;
  const pendingTap =
    isObj(pt) &&
    typeof pt.id === "string" &&
    TAP_KINDS.includes(pt.kind as SurfaceTapKind) &&
    finite(pt.tapMs)
      ? { id: pt.id.toLowerCase(), kind: pt.kind as SurfaceTapKind, tapMs: pt.tapMs }
      : null;
  const nt = raw.notice;
  const notice =
    isObj(nt) && TAP_KINDS.includes(nt.kind as SurfaceTapKind) && typeof nt.text === "string"
      ? { kind: nt.kind as SurfaceTapKind, text: nt.text }
      : null;
  return {
    v: SURFACE_SCHEMA_VERSION,
    enabled: raw.enabled === true,
    status,
    ownerUserId: strOrNull(raw.ownerUserId),
    shiftStartMs: finite(raw.shiftStartMs) ? raw.shiftStartMs : null,
    breakStartMs: finite(raw.breakStartMs) ? raw.breakStartMs : null,
    projectId: strOrNull(raw.projectId),
    label: strOrNull(raw.label),
    startedAtText: strOrNull(raw.startedAtText),
    orgTimeZone: strOrNull(raw.orgTimeZone),
    needsProjectToClockOut: raw.needsProjectToClockOut === true,
    pendingTap,
    notice,
    copy,
    updatedMs: finite(raw.updatedMs) ? raw.updatedMs : 0,
  };
}

function parsePhase(x: unknown): ShiftPhase | null {
  return x === "on" || x === "break" ? x : null;
}

export function parseDismissal(raw: unknown): SurfaceDismissalV1 | null {
  if (!isObj(raw) || raw.v !== SURFACE_SCHEMA_VERSION) return null;
  const phase = parsePhase(raw.phase);
  const surface =
    raw.surface === "live_activity" || raw.surface === "notification" ? raw.surface : null;
  if (!phase || !surface || !finite(raw.shiftStartMs) || !finite(raw.atMs)) return null;
  return { v: SURFACE_SCHEMA_VERSION, surface, shiftStartMs: raw.shiftStartMs, phase, atMs: raw.atMs };
}

export function parseActivityRecord(raw: unknown): ActivityRecordV1 | null {
  if (!isObj(raw) || raw.v !== SURFACE_SCHEMA_VERSION) return null;
  const phase = parsePhase(raw.phase);
  const activityId = strOrNull(raw.activityId);
  if (!phase || !activityId || !finite(raw.shiftStartMs) || !finite(raw.createdMs)) return null;
  return {
    v: SURFACE_SCHEMA_VERSION,
    activityId,
    shiftStartMs: raw.shiftStartMs,
    phase,
    createdMs: raw.createdMs,
    endedByApp: raw.endedByApp === true,
  };
}

function parseActivityInfo(raw: unknown): ActivityInfo | null {
  if (!isObj(raw)) return null;
  const id = strOrNull(raw.id);
  const state = raw.state;
  if (
    !id ||
    !finite(raw.shiftStartMs) ||
    !finite(raw.createdMs) ||
    (state !== "active" && state !== "stale" && state !== "ended" && state !== "dismissed")
  ) {
    return null;
  }
  return { id, shiftStartMs: raw.shiftStartMs, createdMs: raw.createdMs, state };
}

/** The snapshot native returned, or EMPTY_SNAPSHOT for anything unreadable
 *  or from another schema version. */
export function parseSnapshot(text: string | null | undefined): NativeSnapshot {
  const raw = safeJson(text);
  if (!isObj(raw) || raw.schemaVersion !== SURFACE_SCHEMA_VERSION) return EMPTY_SNAPSHOT;
  const platform =
    raw.platform === "ios" || raw.platform === "android" ? raw.platform : "none";
  const activities = Array.isArray(raw.activities)
    ? raw.activities.map(parseActivityInfo).filter((a): a is ActivityInfo => a !== null)
    : [];
  return {
    schemaVersion: SURFACE_SCHEMA_VERSION,
    platform,
    activitiesSupported: raw.activitiesSupported === true,
    activitiesEnabled: raw.activitiesEnabled === true,
    notificationsAllowed: raw.notificationsAllowed === true,
    notificationShown: raw.notificationShown === true,
    activities,
    activityRecord: parseActivityRecord(raw.activityRecord),
    dismissal: parseDismissal(raw.dismissal),
    state: parseState(raw.state),
  };
}

/** The inbox native returned, as raw entries for planInbox. */
export function parseInbox(text: string | null | undefined): unknown[] {
  const raw = safeJson(text);
  return Array.isArray(raw) ? raw : [];
}

/** Every user-facing string, for the copy check. */
export function allCopyStrings(copy: SurfaceCopy = SURFACE_COPY): string[] {
  return [...Object.values(copy), ...Object.values(SURFACE_APP_COPY)];
}
