import AsyncStorage from "@react-native-async-storage/async-storage";

import {
  breakEnd,
  breakStart,
  clockIn,
  clockOut,
  switchProject,
} from "./api";
import type { QueuedCopy, UndoPlan } from "./clock-moment";
import { planRemovesLocalCopy } from "./clock-moment";
import { reportError } from "./error-reporting";

const QUEUE_KEY = "clox.punch.queue.v1";
// The user id that owns the queued punches. Stamped on every enqueue so a
// different user signing in on this device never drains someone else's punches
// under their own token (App reconciles on sign-in). This is what lets the lock
// re-auth path preserve the queue for the SAME user instead of dropping it.
const OWNER_KEY = "clox.punch.queue.owner.v1";

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
  /** Set when the punch can't sync on its own and is kept on the phone for
   *  the worker and their manager instead of being sent or dropped. */
  held?: HeldReason;
  /** For a clock-out, break or switch: the id of the clock-in it belongs to,
   *  when that clock-in was still waiting in this queue at the time of the
   *  tap; null when it had already synced. Stamped by enqueuePunch. Missing
   *  on punches saved by an older app version. */
  dependsOn?: string | null;
};

/**
 * Why a punch is held on the phone.
 *   too_old          More than MAX_REPLAY_AGE_MS old. The server keeps a
 *                    replayed punch's tap time only for 24 hours; after that it
 *                    would record the sync time instead, so the punch is never
 *                    sent and the manager adds the shift by hand.
 *   depends_on_held  A clock-out, break or switch whose clock-in is held. It
 *                    can't land without that clock-in, so it stays with it.
 */
export type HeldReason = "too_old" | "depends_on_held";

/** One hour short of the server's 24-hour window (clampClientTime in the web
 *  repo), so a punch that is sent near the limit still keeps its tap time.
 *  The same margin as the browser's queue (punch-sync-policy.ts). */
export const MAX_REPLAY_AGE_MS = 23 * 60 * 60_000;

export function isTooOldToReplay(clientTime: string, nowMs: number): boolean {
  const ms = Date.parse(clientTime);
  if (Number.isNaN(ms)) return true;
  return nowMs - ms > MAX_REPLAY_AGE_MS;
}

/**
 * Whether the punch at `index` must be held, and why. Pure, so the rules can
 * be checked without AsyncStorage. `items` is the queue in enqueue order with
 * earlier holds already applied, so a clock-in held in the same pass holds the
 * punches that follow it.
 */
export function holdReasonFor(
  items: QueuedPunch[],
  index: number,
  nowMs: number,
): HeldReason | null {
  const punch = items[index];
  if (!punch) return null;
  if (punch.held) return punch.held;
  if (isTooOldToReplay(punch.clientTime, nowMs)) return "too_old";
  if (punch.kind !== "in") {
    if (punch.dependsOn !== undefined) {
      if (punch.dependsOn === null) return null;
      const start = items.find((p) => p.id === punch.dependsOn);
      return start?.held ? "depends_on_held" : null;
    }
    // Saved by an older app version, with no stamp: the nearest earlier
    // clock-in still in the queue is the best guess.
    for (let i = index - 1; i >= 0; i -= 1) {
      const earlier = items[i];
      if (earlier && earlier.kind === "in") {
        return earlier.held ? "depends_on_held" : null;
      }
    }
  }
  return null;
}

export type DrainResult = {
  synced: number;
  /** Punches still waiting to sync (held ones are not counted). */
  remaining: number;
  /** Punches held on the phone because they can't sync on their own. */
  held: number;
  errors: string[];
};

/** Shown once, when a drain first holds a punch. */
const HELD_MESSAGE =
  "A punch saved on this phone is more than a day old, so it can't sync by itself. It is kept on this phone. Ask your manager to add that shift.";

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
  // A break started with no shift running (400). A break end with nothing
  // open comes back 409 and counts as done, so it is never shown; the text is
  // here in case that changes.
  no_active_shift: "You weren't clocked in.",
  no_open_break: "You weren't on a break.",
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

export async function enqueuePunch(
  punch: QueuedPunch,
  userId: string,
): Promise<void> {
  await withQueueLock(async () => {
    const items = await readQueue();
    // Record which queued clock-in this punch belongs to while the queue
    // still shows it; once that clock-in syncs it leaves the queue, and a
    // later look-back could land on an older, held clock-in instead.
    let dependsOn: string | null = null;
    if (punch.kind !== "in") {
      for (let i = items.length - 1; i >= 0; i -= 1) {
        const earlier = items[i];
        if (earlier && earlier.kind === "in") {
          dependsOn = earlier.id;
          break;
        }
      }
    }
    items.push(punch.kind === "in" ? punch : { ...punch, dependsOn });
    await writeQueue(items);
    // Bind the queue to its creator. Only the signed-in user enqueues, so this
    // is always their id; it is read back at sign-in to decide keep vs. clear.
    try {
      await AsyncStorage.setItem(OWNER_KEY, userId);
    } catch {
      // Non-fatal: worst case the owner is unknown and App clears defensively.
    }
  });
}

/** The user id that enqueued the current punches, or null when the queue is
 *  empty / unstamped. */
export async function getQueueOwner(): Promise<string | null> {
  try {
    return await AsyncStorage.getItem(OWNER_KEY);
  } catch {
    return null;
  }
}

/** Punches waiting to sync. Held punches never sync, so they don't count;
 *  otherwise the Clock screen would never take the server's state again. */
export async function queuedCount(): Promise<number> {
  return (await readQueue()).filter((p) => !p.held).length;
}

/** Punches held on the phone because they can't sync on their own. */
export async function heldCount(): Promise<number> {
  return (await readQueue()).filter((p) => p.held).length;
}

/** Every punch stored on the phone, held or not. The account-switch guard
 *  uses this, so another user's held punches are cleared too. */
export async function storedPunchCount(): Promise<number> {
  return (await readQueue()).length;
}

/** The ids of every punch stored on the phone, and which of them are held.
 *  The lock-screen tap pass (shift-actions.ts) reads it to queue a tap at
 *  most once and to tell what became of it after a drain. */
export async function storedPunchIds(): Promise<{ ids: string[]; held: string[] }> {
  const items = await readQueue();
  return {
    ids: items.map((p) => p.id.toLowerCase()),
    held: items.filter((p) => p.held).map((p) => p.id.toLowerCase()),
  };
}

// How punches left the queue in this app session, by id: "sent" (2xx,
// including the server's answer to a replayed idempotency key), "already"
// (409: the state the punch asked for already held, e.g. a clock-out for a
// shift that ended on the web, at a kiosk, by a manager or by the auto
// clock-out, so this punch's time is not the one recorded) or "refused" (a
// 4xx the queue dropped). The lock-screen tap pass reads it after a drain to
// tell the person what happened to their tap. Newest last, capped.
const SETTLED_CAP = 100;
export type SettledOutcome = "sent" | "already" | "refused";
const settledPunches = new Map<string, SettledOutcome>();

function recordSettled(id: string, outcome: SettledOutcome): void {
  const key = id.toLowerCase();
  settledPunches.delete(key);
  settledPunches.set(key, outcome);
  if (settledPunches.size > SETTLED_CAP) {
    const oldest = settledPunches.keys().next().value;
    if (oldest !== undefined) settledPunches.delete(oldest);
  }
}

/** How the punch `id` left the queue in this app session, or null when it
 *  has not (still stored, or it left before this session started). */
export function settledPunchOutcome(id: string): SettledOutcome | null {
  return settledPunches.get(id.toLowerCase()) ?? null;
}

/** Remove the held punches, once the worker's manager has added the shift.
 *  Punches still waiting to sync are kept. */
export async function removeHeldPunches(): Promise<void> {
  await withQueueLock(async () => {
    const items = await readQueue();
    const kept = items.filter((p) => !p.held);
    if (kept.length !== items.length) await writeQueue(kept);
  });
}

/**
 * Drop every queued punch (and its owner stamp). Used by an explicit Sign out
 * (flush what we can, drop the rest) and defensively at sign-in when a
 * DIFFERENT user owns the pending punches. `drainQueue` sends each punch under
 * whatever bearer token is current, so punches must never outlive their owner
 * into another account. The lock re-auth path deliberately does NOT call this —
 * it keeps the queue for the same user, relying on the owner stamp + the
 * sign-in reconcile guard for safety.
 */
export async function clearQueue(): Promise<void> {
  await withQueueLock(async () => {
    try {
      await AsyncStorage.removeItem(QUEUE_KEY);
      await AsyncStorage.removeItem(OWNER_KEY);
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

// ---------------------------------------------------------------------------
// What an undo of a clock-in needs from the queue
// ---------------------------------------------------------------------------

/**
 * Punch ids a drain pass has handed to the network in this app session. A
 * punch still queued after that may have reached the server even though no
 * answer came back (a dropped connection, a 5xx), so an undo of it must also
 * ask the server. The Clock screen's undo offer lives only as long as this
 * JS session, so an in-memory record covers every tap on it. Entries go when
 * the punch leaves the queue.
 */
const sendAttempted = new Set<string>();

/**
 * Punch ids a drain pass must not send, because an undo is deciding what to
 * do with them. A pass stops at one rather than skipping it, so the punches
 * after it keep their order.
 */
const withheld = new Set<string>();

/** The punch a drain pass is sending right now. `settled` resolves once that
 *  send's outcome is written back to the queue. */
let inFlight: { id: string; settled: Promise<void> } | null = null;

/**
 * Take the clock-in `punchId` out of the queue for an undo, when `plan` says
 * to. `plan` is given what the queue holds for it (null once it has left the
 * queue: sent and answered, or dropped) and returns the undo plan
 * (clock-moment.ts planUndo).
 *
 * Safe against a drain running at the same time: the punch is withheld from
 * any later pass first, then a send of it already on the wire is waited out,
 * then the queue is read and changed inside the queue lock. Without the wait
 * a pass could deliver the clock-in after it was removed here, and the
 * server would keep it. A punch the plan keeps is released to the next sync.
 * Returns null, having changed nothing, when a send of it is still on the
 * wire after `maxWaitMs`, or is found on the wire inside the lock.
 */
export async function takeQueuedClockInForUndo(
  punchId: string,
  plan: (copy: QueuedCopy | null) => UndoPlan,
  maxWaitMs: number,
): Promise<UndoPlan | null> {
  withheld.add(punchId);
  try {
    // A send of this punch already on the wire: wait for its answer, but not
    // forever. Null tells the caller nothing was decided or changed.
    const deadline = Date.now() + maxWaitMs;
    while (inFlight && inFlight.id === punchId) {
      const left = deadline - Date.now();
      if (left <= 0) return null;
      await Promise.race([
        inFlight.settled,
        new Promise<void>((resolve) => setTimeout(resolve, left)),
      ]);
    }
    return await withQueueLock(async () => {
      // A drain picked it up after all: its send is on the wire, so nothing
      // is decided here (the same answer as a wait that ran out).
      if (inFlight && inFlight.id === punchId) return null;
      const items = await readQueue();
      const idx = items.findIndex((p) => p.id === punchId);
      const found = idx >= 0 ? items[idx] : undefined;
      const copy: QueuedCopy | null = found
        ? {
            attempted: sendAttempted.has(punchId),
            hasLaterPunches: items.some((p) => p.dependsOn === punchId),
          }
        : null;
      const decided = plan(copy);
      if (found && planRemovesLocalCopy(decided)) {
        items.splice(idx, 1);
        await writeQueue(items);
        sendAttempted.delete(punchId);
      }
      return decided;
    });
  } finally {
    withheld.delete(punchId);
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
// Resolves when the drain running now (if any) has finished. A caller whose
// drainQueue() returned at once because another drain was running waits on
// this to know its punch was tried.
let drainIdle: Promise<void> = Promise.resolve();

/** Resolves once no drain is running. */
export function whenDrainIdle(): Promise<void> {
  return drainIdle;
}

export async function drainQueue(token: string): Promise<DrainResult> {
  const errors: string[] = [];
  let synced = 0;

  // Only one drain at a time. Overlapping drains (online + visibilitychange
  // firing together) would each read the queue and double-send / clobber.
  if (draining) {
    return { synced, remaining: await queuedCount(), held: await heldCount(), errors };
  }
  draining = true;
  let idle: () => void = () => {};
  drainIdle = new Promise<void>((resolve) => {
    idle = resolve;
  });

  try {
    // Process the oldest punch still waiting to sync each pass. On the way,
    // inside the lock, hold any punch too old to keep its tap time and any
    // punch whose clock-in is held; held punches stay in the queue in their
    // place and are never sent. Network happens outside the lock; the item is
    // then removed by id inside the lock, so a punch enqueued concurrently (a
    // live tap mid-sync) is never dropped.
    let newlyHeld = 0;
    for (;;) {
      let settle: () => void = () => {};
      const head = await withQueueLock(async () => {
        const items = await readQueue();
        const nowMs = Date.now();
        let changed = false;
        let next: QueuedPunch | null = null;
        for (let i = 0; i < items.length; i += 1) {
          const item = items[i];
          if (!item || item.held) continue;
          const reason = holdReasonFor(items, i, nowMs);
          if (reason) {
            items[i] = { ...item, held: reason };
            changed = true;
            newlyHeld += 1;
            continue;
          }
          // An undo is deciding about this one: stop here, keeping order.
          if (withheld.has(item.id)) break;
          next = item;
          break;
        }
        if (changed) await writeQueue(items);
        // The write yields, and an undo may have withheld the pick meanwhile
        // (it saw no send in flight yet). Stop the pass instead of sending.
        if (next && withheld.has(next.id)) next = null;
        if (next) {
          // Recorded inside the lock, in the same step as the pick, so an
          // undo either sees this send or stops the pass before it.
          sendAttempted.add(next.id);
          const settled = new Promise<void>((resolve) => {
            settle = resolve;
          });
          inFlight = { id: next.id, settled };
        }
        return next;
      });
      if (!head) break;

      try {
        let outcome: "done" | "drop" | "stop";
        // A 409: what the punch asked for already holds on the server (a
        // replayed idempotency key answers 2xx; a 409 is nothing_to_stop,
        // already_on_break or no_open_break), so its own time was not used.
        let conflict = false;
        try {
          const res = await send(token, head);
          if (res.ok || res.status === 409) {
            // 409 = already reflected on the server — done.
            outcome = "done";
            conflict = res.status === 409;
          } else if (res.status === 401) {
            // Token expired/invalid, or "mfa_required" (a password-only
            // session on an account with 2FA on: App shows the code step and
            // drains again once it is in). Keep the punch and stop; a later
            // drain resumes. The server must answer these with 401, never
            // 403, which the branch below would drop.
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
        sendAttempted.delete(head.id);
        recordSettled(head.id, outcome === "drop" ? "refused" : conflict ? "already" : "sent");

        if (outcome === "done") synced += 1;
      } finally {
        // Let an undo waiting on this punch read the queue now.
        inFlight = null;
        settle();
      }
    }
    if (newlyHeld > 0) errors.unshift(HELD_MESSAGE);
  } finally {
    draining = false;
    idle();
  }

  return { synced, remaining: await queuedCount(), held: await heldCount(), errors };
}
