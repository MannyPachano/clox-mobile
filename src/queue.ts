import AsyncStorage from "@react-native-async-storage/async-storage";

import {
  breakEnd,
  breakStart,
  clockIn,
  clockOut,
  switchProject,
} from "./api";
import { reportError } from "./error-reporting";

const QUEUE_KEY = "clox.punch.queue.v1";

export type PunchKind =
  | "in"
  | "out"
  | "break_start"
  | "break_end"
  | "switch_project";

export type QueuedPunch = {
  id: string; // UUID — also the server idempotency key
  kind: PunchKind;
  clientTime: string; // ISO timestamp of the tap
  projectId: string | null;
  taskId: string | null;
  note: string | null;
  selfie: string | null; // base64 data URL, only on clock-in when required
  latitude: number | null;
  longitude: number | null;
  accuracyM: number | null;
  mocked: boolean | null; // device mock-location flag at clock-in (Android only)
  /** switch_project only — true retags the whole current entry in place
   *  instead of splitting it at clientTime. */
  applyToShift?: boolean;
};

export type DrainResult = {
  synced: number;
  remaining: number;
  errors: string[];
};

const LABELS: Record<PunchKind, string> = {
  in: "Clock-in",
  out: "Clock-out",
  break_start: "Break start",
  break_end: "Break end",
  switch_project: "Project switch",
};

// Friendly text for the server's error codes (shown in the banner).
const ERROR_MESSAGES: Record<string, string> = {
  // Ordered by how far the location check got: no fix, then a fix too coarse to
  // trust, then a good fix that landed outside the fence.
  geo_required: "Turn on location so Clox can check the job site.",
  geo_inaccurate:
    "The GPS signal is too weak to place you. Move into the open and try again.",
  geo_outside: "You're not at the job site. Move on site and try again.",
  project_required: "Pick a project first.",
  bad_project: "That project isn't available.",
  no_scheduled_shift: "You don't have a scheduled shift right now.",
  too_early: "It's too early for your scheduled shift.",
  nothing_to_stop: "You weren't clocked in.",
  // Server gates new clock-ins once the org's trial ends with no plan.
  trial_expired:
    "Your team's Clox trial has ended. Ask your manager to pick a plan, then you can clock in again.",
};

function friendly(code: string): string {
  return ERROR_MESSAGES[code] ?? code;
}

async function readQueue(): Promise<QueuedPunch[]> {
  const raw = await AsyncStorage.getItem(QUEUE_KEY);
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw) as unknown;
    return Array.isArray(parsed) ? (parsed as QueuedPunch[]) : [];
  } catch {
    return [];
  }
}

async function writeQueue(items: QueuedPunch[]): Promise<void> {
  try {
    await AsyncStorage.setItem(QUEUE_KEY, JSON.stringify(items));
  } catch (err) {
    // A failed write means a punch would be silently lost on restart. Report
    // it (so it's visible in the beta) and rethrow so the caller can tell the
    // user instead of pretending the punch was saved.
    reportError(err, "queue.writeQueue");
    throw err;
  }
}

/**
 * Serializes every read-modify-write on the queue. `enqueuePunch` and the
 * per-item removal in `drainQueue` both run inside this lock so they can never
 * interleave (the bug this fixes: enqueue reads [A,B], drain reads [A,B] and
 * writes [B], enqueue writes [A,B,C] — C or A silently lost). Network I/O in
 * drain happens OUTSIDE the lock, so a hung request can't block a new tap.
 */
let queueLock: Promise<unknown> = Promise.resolve();
function withQueueLock<T>(fn: () => Promise<T>): Promise<T> {
  const run = queueLock.then(fn, fn);
  // Keep the chain alive but swallow settle state so one failure never poisons
  // later critical sections.
  queueLock = run.then(
    () => undefined,
    () => undefined,
  );
  return run;
}

export async function enqueuePunch(punch: QueuedPunch): Promise<void> {
  await withQueueLock(async () => {
    const items = await readQueue();
    items.push(punch);
    await writeQueue(items);
  });
}

export async function queuedCount(): Promise<number> {
  return (await readQueue()).length;
}

/**
 * Drop every queued punch. Called on sign-out: the queue is a single
 * device-global key with no per-user scoping, and `drainQueue` sends each
 * punch under whatever bearer token is current. Without this, punches the
 * previous user queued offline would drain under the NEXT person to sign in
 * on the same device, recording one worker's shift as another's.
 */
export async function clearQueue(): Promise<void> {
  await withQueueLock(async () => {
    try {
      await AsyncStorage.removeItem(QUEUE_KEY);
    } catch (err) {
      reportError(err, "queue.clearQueue");
    }
  });
}

function send(token: string, punch: QueuedPunch) {
  switch (punch.kind) {
    case "in":
      return clockIn(token, punch);
    case "out":
      return clockOut(token, punch);
    case "break_start":
      return breakStart(token, punch);
    case "break_end":
      return breakEnd(token, punch);
    case "switch_project":
      return switchProject(token, punch);
  }
}

/**
 * Send queued punches to the server in order. Stops at the first network
 * failure or auth error so order is preserved and the tail retries later.
 * Terminal 4xx rejections are dropped (with the reason recorded) so the queue
 * can never wedge forever. Idempotency keys make every re-send safe — a punch
 * already applied server-side comes back as the prior result or a 409, which we
 * treat as "done".
 */
let draining = false;

export async function drainQueue(token: string): Promise<DrainResult> {
  const errors: string[] = [];
  let synced = 0;

  // Only one drain at a time. Overlapping drains (online + visibilitychange
  // firing together) would each read the queue and double-send / clobber.
  if (draining) {
    return { synced, remaining: await queuedCount(), errors };
  }
  draining = true;

  try {
    // Process the oldest item each pass. Network happens outside the lock;
    // the item is then removed by id inside the lock, so a punch enqueued
    // concurrently (a live tap mid-sync) is never dropped.
    for (;;) {
      const head = await withQueueLock(async () => (await readQueue())[0] ?? null);
      if (!head) break;

      let outcome: "done" | "drop" | "stop";
      try {
        const res = await send(token, head);
        if (res.ok || res.status === 409) {
          // 409 = already reflected on the server (idempotent replay) — done.
          outcome = "done";
        } else if (res.status === 401) {
          // Token expired/invalid — stop; auth refresh + a later drain resumes.
          outcome = "stop";
        } else if (res.status >= 400 && res.status < 500) {
          // Won't succeed on retry (geo_outside, project_required, …) — drop it
          // and surface a friendly reason instead of looping forever.
          errors.push(`${LABELS[head.kind]} failed: ${friendly(res.error)}`);
          outcome = "drop";
        } else {
          // 5xx / unexpected — keep and retry later.
          outcome = "stop";
        }
      } catch {
        // Network down — keep everything, retry on reconnect.
        outcome = "stop";
      }

      if (outcome === "stop") break;

      // Remove exactly this item by id (not by position) so concurrently
      // enqueued punches survive.
      await withQueueLock(async () => {
        const items = await readQueue();
        const idx = items.findIndex((i) => i.id === head.id);
        if (idx >= 0) {
          items.splice(idx, 1);
          await writeQueue(items);
        }
      });

      if (outcome === "done") synced += 1;
    }
  } finally {
    draining = false;
  }

  return { synced, remaining: await queuedCount(), errors };
}
