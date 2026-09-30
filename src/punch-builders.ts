import type { QueuedPunch } from "./queue";

/**
 * Builders for queued punches that more than one caller makes. Pure (type
 * imports only), so scripts/shift-surface-check.mjs can run it under node.
 */

/** The punches a lock-screen, widget or notification button can make, and
 *  the ones the Clock screen makes with no GPS, selfie or note. */
export type SimplePunchKind = "out" | "break_start" | "break_end";

export type SimplePunchInput = {
  /** Lowercase UUID, also the server's idempotency key. */
  id: string;
  /** ISO time of the tap. */
  clientTime: string;
  /** The running shift's project. Sent with a clock-out only. */
  projectId: string | null;
};

/**
 * A clock-out or break punch. Location is never read for these: the server's
 * geofence and selfie rules apply to clock-in only, so they carry nulls. The
 * Clock screen (enqueueSimple) and the lock-screen tap inbox
 * (shift-surface-state.ts planInbox) both build them here, so a tap from
 * either place becomes the same punch.
 */
export function buildSimplePunch(
  kind: SimplePunchKind,
  input: SimplePunchInput,
): QueuedPunch {
  return {
    id: input.id,
    kind,
    clientTime: input.clientTime,
    projectId: kind === "out" ? input.projectId : null,
    taskId: null,
    note: null,
    selfie: null,
    latitude: null,
    longitude: null,
    accuracyM: null,
    mocked: null,
  };
}
