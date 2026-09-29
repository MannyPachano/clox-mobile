import { requireOptionalNativeModule } from "expo";

import {
  EMPTY_SNAPSHOT,
  SURFACE_SCHEMA_VERSION,
  type ActivityPlan,
  type LiveActivityView,
  type NotificationView,
  type SurfaceDismissalV1,
  type SurfaceStateV1,
} from "./shift-surface-state";

/**
 * The app's handle on the native module that draws the running shift
 * outside the app (modules/clox-shift-surface: Swift for the iOS Live
 * Activity and widget, Kotlin for the Android notification). The rules live
 * in shift-surface-state.ts; this file is the typed bridge and the off
 * switch.
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
