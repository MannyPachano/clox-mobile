import { requireOptionalNativeModule } from "expo";
import { AppState } from "react-native";

import { reportError } from "./error-reporting";
import { getOrgTz } from "./lib/org-tz";
import { orgWallClock } from "./lib/zoned-time";
import {
  buildSurfaceState,
  EMPTY_SNAPSHOT,
  parseInbox,
  parseSnapshot,
  planSurfaceApply,
  SURFACE_SCHEMA_VERSION,
  type ActivityPlan,
  type LiveActivityView,
  type NativeSnapshot,
  type NotificationView,
  type SurfaceApply,
  type SurfaceApplyInput,
  type SurfaceDismissalV1,
  type SurfaceInput,
  type SurfaceStateV1,
} from "./shift-surface-state";

/**
 * The app's handle on the native module that draws the running shift
 * outside the app (modules/clox-shift-surface: Swift for the iOS Live
 * Activity and widget, Kotlin for the Android notification). The rules live
 * in shift-surface-state.ts; this file is the typed bridge, the off switch,
 * and the one line every native write goes through (pushes from the Clock
 * screen, a tap's outcome from shift-actions.ts, sign-out).
 *
 * The module is optional. Expo Go, any build without it, and a binary that
 * speaks another schema version all get the no-op module: every call
 * resolves with nothing to do, and the app behaves as before this feature.
 * (The 1.3.0 store build never receives this JavaScript, since EAS Update
 * matches the runtime version, which is the app version; the guard covers
 * it anyway.)
 * Never import @bacons/apple-targets from JavaScript; it is a build-time
 * config plugin plus a module this app does not use.
 */

/**
 * The remote off switch. Set false and publish an EAS Update to runtime
 * 1.4.0: the next state push carries `enabled: false`, which ends every Live
 * Activity and the Android notification, turns the widget into a plain Open
 * Clox link, and makes the native side ignore new taps. Taps already saved
 * are still turned into punches; they are real clock-outs and breaks.
 */
export const SHIFT_SURFACES_ENABLED = true;

/** The name the Swift and Kotlin modules register (Name("CloxShiftSurface")). */
export const SHIFT_SURFACE_MODULE_NAME = "CloxShiftSurface";

/**
 * Android: the headless JS task every notification tap starts (the Kotlin
 * ShiftActionTaskService, SurfaceContract.HEADLESS_TASK), in the app's
 * running React instance or a new one without a screen. While it runs, the
 * process is kept out of the frozen cached state and the JavaScript timers
 * keep running, which a paused app in the background does not get. index.js
 * registers it with AppRegistry.registerHeadlessTask before
 * registerRootComponent; its data is `{ id }`, the tap just saved, and it
 * runs the same inbox pass as the onTap event (read the whole inbox, queue,
 * ack, drain). A listening JavaScript gets the onTap event for the same tap,
 * so the pass must be single-flight. The service stops it after 30 seconds.
 */
export const SHIFT_ACTION_TASK_NAME = "CloxShiftAction";

/**
 * One call's worth of work for native, decided in JS. Native applies it in
 * this order: write `state` to the shared store (and reload the widget
 * timelines), end, update or start Live Activities, then post or cancel the
 * notification. Serialized as JSON.
 */
export type NativeApplyPlan = {
  v: typeof SURFACE_SCHEMA_VERSION;
  state: SurfaceStateV1;
  /** iOS. `view` is surfaceView(state).activity, the content to start or
   *  update with. `finalCard`, when set, ends `plan.endNow` with that line
   *  left on the Lock Screen until dismissAtMs instead of at once. */
  activity: {
    plan: ActivityPlan;
    view: LiveActivityView;
    finalCard: { text: string; dismissAtMs: number } | null;
  };
  /** Android. `view` is surfaceView(state).notification. `finalCard`, when
   *  set with `cancel`, posts a plain notification with that line that
   *  times out at dismissAtMs. */
  notification: {
    post: boolean;
    cancel: boolean;
    view: NotificationView;
    finalCard: { text: string; dismissAtMs: number } | null;
  };
  /** Clear a saved dismissal (a new shift or phase no longer needs it), or
   *  save one planActivity inferred. Undefined leaves it as it is. */
  dismissal?: SurfaceDismissalV1 | null;
};

/** What native reports back from apply(). Serialized as JSON. */
export type NativeApplyResult = {
  /** The id of an activity started by this call, or null. */
  startedActivityId: string | null;
  /** Anything native could not do (ActivityKit refused a start, the
   *  notification permission is off). Reported, never shown. */
  errors: string[];
};

/** A tap native saved while the JavaScript was running. */
export type TapEvent = { id: string };

/**
 * The native module's surface. Every payload is a JSON string, so the Swift
 * and Kotlin sides decode one versioned shape each and ignore what they do
 * not know (shift-surface-state.ts has the shapes and the key names).
 */
export interface CloxShiftSurfaceModule {
  /** SURFACE_SCHEMA_VERSION of the binary. A mismatch means no-op. */
  readonly schemaVersion: number;
  /** JSON NativeSnapshot: the state, activities, record, dismissal and
   *  permission facts, read in one go. */
  readSnapshot(): Promise<string>;
  /** Apply a JSON NativeApplyPlan. Resolves with a JSON NativeApplyResult. */
  apply(planJson: string): Promise<string>;
  /** JSON SurfaceTapV1[]: the taps saved and not yet acked, oldest first. */
  readInbox(): Promise<string>;
  /** Remove these tap ids from the inbox (queued, or dropped for good). */
  ackTaps(ids: string[]): Promise<void>;
  /** iOS: releases a LiveActivityIntent waiting in perform() for its tap,
   *  first once it is queued, then once the drain that sends it is done.
   *  Android: no-op. */
  signalTap(id: string, stage: "queued" | "done"): Promise<void>;
  /** Sign-out, account deletion, re-auth and account switch: end every
   *  activity at once, cancel the notification, and clear the state, the
   *  inbox, the dismissal and the activity record. */
  clearAll(): Promise<void>;
  addListener(
    eventName: "onTap",
    listener: (event: TapEvent) => void,
  ): { remove(): void };
}

const NO_OP_RESULT: NativeApplyResult = { startedActivityId: null, errors: [] };

/** Stands in for the module wherever it is missing. */
export const noopShiftSurface: CloxShiftSurfaceModule = {
  schemaVersion: SURFACE_SCHEMA_VERSION,
  readSnapshot: async () => JSON.stringify(EMPTY_SNAPSHOT),
  apply: async () => JSON.stringify(NO_OP_RESULT),
  readInbox: async () => "[]",
  ackTaps: async () => {},
  signalTap: async () => {},
  clearAll: async () => {},
  addListener: () => ({ remove() {} }),
};

let resolved: { module: CloxShiftSurfaceModule; native: boolean } | null = null;

function resolveModule(): { module: CloxShiftSurfaceModule; native: boolean } {
  if (resolved) return resolved;
  let found: CloxShiftSurfaceModule | null = null;
  try {
    found = requireOptionalNativeModule<CloxShiftSurfaceModule>(
      SHIFT_SURFACE_MODULE_NAME,
    );
  } catch {
    found = null;
  }
  resolved =
    found && found.schemaVersion === SURFACE_SCHEMA_VERSION
      ? { module: found, native: true }
      : { module: noopShiftSurface, native: false };
  return resolved;
}

/** The native module, or the no-op stand-in. */
export function getShiftSurface(): CloxShiftSurfaceModule {
  return resolveModule().module;
}

/** True when this binary has the native module at the schema this
 *  JavaScript speaks. False in Expo Go and in builds before 1.4.0. */
export function hasNativeShiftSurface(): boolean {
  return resolveModule().native;
}

// ── Org-zone clock text ───────────────────────────────────────────────────

/**
 * "9:42 AM" in the org's zone, or null when the org's zone is not known on
 * this phone yet (a cold start with no signal) or this phone's ICU does not
 * know it. The surfaces then leave the start line out rather than show the
 * phone's own zone. Built on zoned-time's guarded formatter (orgWallClock),
 * so it adds no Intl of its own.
 */
export function orgClockText(ms: number): string | null {
  return clockTextIn(ms, getOrgTz());
}

/** "9:42 AM" in `tz`, or null for no zone or one this phone cannot use. */
export function clockTextIn(ms: number, tz: string | null | undefined): string | null {
  const w = orgWallClock(ms, tz ?? undefined);
  if (!w) return null;
  const h12 = w.h % 12 === 0 ? 12 : w.h % 12;
  const mm = w.mi < 10 ? `0${w.mi}` : String(w.mi);
  return `${h12}:${mm} ${w.h < 12 ? "AM" : "PM"}`;
}

/**
 * The org's zone for a surface write: the one this app run learned from the
 * server, else the one saved with the surface state for the same person (a
 * start with no signal yet, or iOS starting the app in the background for a
 * button, before any status has loaded).
 */
export function surfaceZone(saved: SurfaceStateV1 | null, userId: string | null): string | null {
  const live = getOrgTz();
  if (live) return live;
  if (saved && userId && saved.ownerUserId === userId) return saved.orgTimeZone;
  return null;
}

// ── One line for every native write ───────────────────────────────────────

let chain: Promise<unknown> = Promise.resolve();

/**
 * Runs `op` after every surface operation already started, so a push, a
 * tap's outcome and a sign-out never interleave their read of native's
 * snapshot with another's write. A failure is reported and never breaks the
 * line for the next one.
 */
export function runSurfaceOp<T>(where: string, op: () => Promise<T>): Promise<T | null> {
  const run = chain.then(op).catch((err: unknown) => {
    reportError(err, where);
    return null;
  });
  chain = run;
  return run;
}

/** The app is in the foreground. A Live Activity can only start then. */
export function isForeground(): boolean {
  return AppState.currentState === "active";
}

/** Reads native's snapshot and inbox in one go. */
export async function readNative(): Promise<{ snapshot: NativeSnapshot; inbox: unknown[] }> {
  const mod = getShiftSurface();
  const snapshot = parseSnapshot(await mod.readSnapshot());
  const inbox = parseInbox(await mod.readInbox());
  return { snapshot, inbox };
}

/** Sends one plan to native. Anything native could not do is reported, never
 *  shown: the surfaces are a convenience, the queue is the record. */
export async function applyNative(apply: SurfaceApply): Promise<void> {
  const plan: NativeApplyPlan = { v: SURFACE_SCHEMA_VERSION, ...apply };
  const text = await getShiftSurface().apply(JSON.stringify(plan));
  let result: Partial<NativeApplyResult> | null = null;
  try {
    result = JSON.parse(text) as Partial<NativeApplyResult>;
  } catch {
    result = null;
  }
  const errors = Array.isArray(result?.errors) ? result.errors : [];
  // Live Activities turned off, an iPhone below iOS 17 and notifications
  // not allowed are the person's settings or their phone, not faults.
  const faults = errors.filter(
    (e) =>
      typeof e === "string" &&
      !/turned off|need iOS 17|not allowed on this phone/i.test(e),
  );
  if (faults.length > 0) {
    reportError(new Error(`shift surface: ${faults.join("; ")}`), "shift-surface.apply");
  }
}

/** Plans and applies one state change, unless it changes nothing. */
export async function planAndApply(
  input: Omit<SurfaceApplyInput, "snapshot" | "inbox">,
): Promise<void> {
  const { snapshot, inbox } = await readNative();
  if (snapshot.platform === "none") return;
  const { apply, changed } = planSurfaceApply({ ...input, snapshot, inbox });
  if (changed) await applyNative(apply);
}

// ── Pushes from the app ───────────────────────────────────────────────────

// Pushes are made only for the person this phone is armed for. The Clock
// screen arms on mount; sign-out, account deletion and re-authentication
// disarm before they clear, so a refresh that lands after them draws
// nothing for the person who left.
let armedFor: string | null = null;

export function armShiftSurface(userId: string): void {
  armedFor = userId;
}

/** The running shift as the app knows it, for pushShiftSurface. */
export type SurfaceShift = Omit<SurfaceInput, "enabled" | "orgTimeZone">;

/**
 * Draw the app's own view of the shift on every surface. The Clock screen
 * calls it only when it changes the shift itself (a clock-in, an undo, a
 * break, a project or task switch, a clock-out) and when a refresh applies
 * the server's answer, never on every render: a cold start with punches
 * still queued shows Not clocked in until they send, and mirroring that
 * would end a correct Live Activity.
 */
export function pushShiftSurface(shift: SurfaceShift): Promise<void> {
  if (!hasNativeShiftSurface()) return Promise.resolve();
  return runSurfaceOp("shift-surface.push", async () => {
    if (!shift.userId || armedFor !== shift.userId) return;
    const { snapshot, inbox } = await readNative();
    if (snapshot.platform === "none") return;
    const nowMs = Date.now();
    const tz = surfaceZone(snapshot.state, shift.userId);
    const next = buildSurfaceState(
      { ...shift, enabled: SHIFT_SURFACES_ENABLED, orgTimeZone: tz },
      nowMs,
      (ms) => clockTextIn(ms, tz),
    );
    const { apply, changed } = planSurfaceApply({
      snapshot,
      inbox,
      next,
      nowMs,
      foreground: isForeground(),
      source: "push",
    });
    if (changed) await applyNative(apply);
  }).then(() => undefined);
}

/**
 * Sign-out and account deletion: nothing of this person's may stay on the
 * Lock Screen, in the widget or in the notification shade, and no saved tap
 * may send later. Ends every activity at once, cancels the notification and
 * clears the state, the inbox, the dismissal and the activity record.
 */
export function clearShiftSurfaces(): Promise<void> {
  armedFor = null;
  if (!hasNativeShiftSurface()) return Promise.resolve();
  return runSurfaceOp("shift-surface.clear", () => getShiftSurface().clearAll()).then(
    () => undefined,
  );
}

/**
 * Re-authentication from the app lock, and another account signing in over
 * a state left behind: take every surface down (the shift shows for nobody
 * now) but keep the tap inbox. The queue is kept the same way; a saved tap
 * is queued once its own account is signed in again, and dropped, with a
 * word to the person, if another account signs in (shift-actions.ts).
 * `unlessOwner`: leave everything alone when the state already belongs to
 * this user.
 */
export function signOutShiftSurfaces(unlessOwner?: string): Promise<void> {
  if (!unlessOwner) armedFor = null;
  if (!hasNativeShiftSurface()) return Promise.resolve();
  return runSurfaceOp("shift-surface.signOut", async () => {
    const { snapshot } = await readNative();
    if (snapshot.platform === "none") return;
    const owner = snapshot.state?.ownerUserId ?? null;
    if (unlessOwner && (!owner || owner === unlessOwner)) return;
    const nowMs = Date.now();
    const next = buildSurfaceState(
      {
        enabled: SHIFT_SURFACES_ENABLED,
        userId: null,
        shiftStartMs: null,
        breakStartMs: null,
        projectId: null,
        projectName: null,
        taskName: null,
        requireProject: false,
        orgTimeZone: null,
      },
      nowMs,
      orgClockText,
    );
    await planAndApply({ next, nowMs, foreground: isForeground(), source: "settle" });
  }).then(() => undefined);
}
