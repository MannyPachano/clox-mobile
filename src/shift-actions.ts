import AsyncStorage from "@react-native-async-storage/async-storage";
import { AppState } from "react-native";

import { SUPABASE_URL } from "./config";
import { reportError } from "./error-reporting";
import { buildSimplePunch } from "./punch-builders";
import {
  drainQueue,
  enqueuePunch,
  getQueueOwner,
  settledPunchOutcome,
  storedPunchIds,
  whenDrainIdle,
  type DrainResult,
} from "./queue";
import { cancelLongShiftReminders } from "./reminder-notifications";
import { SecureStoreAdapter } from "./secure-storage";
import {
  applyNative,
  clockTextIn,
  getShiftSurface,
  hasNativeShiftSurface,
  isForeground,
  readNative,
  runSurfaceOp,
  surfaceZone,
} from "./shift-surface";
import {
  parseInbox,
  parseTap,
  planInbox,
  planSurfaceApply,
  settleTaps,
  storedSessionUserId,
  SURFACE_APP_COPY,
  tapOutcomeFrom,
  type SessionView,
  type SettledTap,
  type SurfaceTapKind,
  type SurfaceTapV1,
  type TapOutcome,
} from "./shift-surface-state";
import { getAccessToken, supabase } from "./supabase";

/**
 * Lock Screen, widget and notification taps, turned into punches.
 *
 * The native module saves a tap to its inbox and wakes this JavaScript: the
 * "onTap" event when the app's JavaScript is running and listening; on
 * Android also the headless task "CloxShiftAction", which every notification
 * tap starts (in the running app too: a headless task keeps a backgrounded
 * app's timers running and its process out of the frozen cached state until
 * the pass is done); and on iOS a background launch of the app, where the
 * event arrives once this file starts listening. The app
 * also looks at the inbox when it starts and each time it comes to the
 * foreground, so a tap nothing woke up for is sent at the next open, with
 * its tap time.
 *
 * One punch path. A tap becomes the same queued punch the Clock screen makes
 * (buildSimplePunch + queue.ts enqueuePunch) and leaves through the same
 * drain, so order, idempotency, the 23 hour hold and the owner stamp are the
 * queue's own. Nothing here talks to the server except through drainQueue.
 *
 * A pass, one at a time:
 *   1. Read the inbox, the session and the queue, and plan
 *      (shift-surface-state.ts planInbox): queue a tap only for the signed-in
 *      account it was saved under, at most once. A session that cannot be
 *      read keeps the tap for later; another account drops it, and the
 *      person is told.
 *   2. Queue, remember the tap ids as handled, and tell the Clock screen if
 *      it is mounted (it shows the change at once and ignores any refresh
 *      that started before it).
 *   3. Drain, within a time budget (the iOS button waits about 20 seconds,
 *      the Android task 30).
 *   4. In the surface line (shift-surface.ts runSurfaceOp): ack the taps,
 *      then write each tap's outcome (sent, saved on this phone, refused).
 *      Acking first matters: native keeps a pending look for any tap still
 *      in its inbox.
 *   5. Release the iOS button ("done"), cancel the long shift reminder after
 *      a clock-out, and tell the Clock screen.
 *
 * Location is never read here (buildSimplePunch sends none for a clock-out
 * or a break), and nothing here depends on a screen, so it runs the same
 * with the app lock up, on a background launch and in the headless task.
 */

/** Tap ids already queued, newest last (planInbox's handledIds). */
const HANDLED_KEY = "clox.surface.handled.v1";

/** How long a pass waits for its punches to send before it settles what it
 *  has (a punch still on its way reads as saved on this phone). With the
 *  session budget below, it leaves room inside the iOS button's 20 second
 *  wait for the write that follows. */
const DRAIN_BUDGET_MS = 12_000;
/** How long the session read may take (it can refresh the access token over
 *  the network) before the copy in secure storage answers. */
const SESSION_BUDGET_MS = 4_000;

// ── Telling the Clock screen ─────────────────────────────────────────────

export type SurfaceTapEvent =
  /** Taps queued for `userId`, before they are sent. */
  | {
      type: "queued";
      userId: string;
      taps: { id: string; kind: SurfaceTapKind; tapMs: number }[];
    }
  /** The pass is done: `drain` is its drain's result, when it ran one. */
  | {
      type: "settled";
      userId: string | null;
      drain: DrainResult | null;
      outcomes: { id: string; kind: SurfaceTapKind; outcome: TapOutcome }[];
    }
  /** A line for the banner. */
  | { type: "notice"; text: string };

type Listener = (event: SurfaceTapEvent) => void;

const listeners = new Set<Listener>();
// A notice with no screen to show it yet (another account's tap, dropped at
// sign-in before the Clock screen mounted). The next listener gets it.
let heldNotice: string | null = null;

/** The Clock screen listens while it is mounted. Returns the unsubscribe. */
export function subscribeSurfaceTaps(listener: Listener): () => void {
  listeners.add(listener);
  if (heldNotice) {
    const text = heldNotice;
    heldNotice = null;
    void Promise.resolve().then(() => listener({ type: "notice", text }));
  }
  return () => {
    listeners.delete(listener);
  };
}

function emit(event: SurfaceTapEvent): void {
  for (const listener of Array.from(listeners)) {
    try {
      listener(event);
    } catch (err) {
      reportError(err, "shift-actions.listener");
    }
  }
}

function notice(text: string): void {
  if (listeners.size === 0) heldNotice = text;
  else emit({ type: "notice", text });
}

// ── The session ──────────────────────────────────────────────────────────

/** supabase-js's default storage key for this project,
 *  `sb-${hostname.split(".")[0]}-auth-token`, read without URL (React
 *  Native's own URL has no hostname). */
function sessionStorageKey(): string | null {
  const ref = /^[a-z][a-z0-9+.-]*:\/\/([^./:?#]+)/i.exec(SUPABASE_URL)?.[1];
  return ref ? `sb-${ref}-auth-token` : null;
}

/**
 * Who is signed in, for work done without a screen:
 *   user        the session this phone holds, including one whose access
 *               token could not be refreshed (offline): the queue sends it
 *               once the token refreshes, and the account-switch guard in
 *               App.tsx covers a different account signing in.
 *   signed_out  no session is stored.
 *   unknown     the session could not be read (a Keychain read the phone
 *               refused, a storage error). Not the same as signed out.
 */
export async function readSessionView(): Promise<SessionView> {
  // getSession can refresh the access token over the network, which has no
  // timeout of its own; past the budget the stored copy answers instead.
  const live = await withBudget(
    (async (): Promise<SessionView | null> => {
      try {
        const { data, error } = await supabase.auth.getSession();
        const uid = data.session?.user?.id;
        if (uid) return { kind: "user", userId: uid };
        if (!error) return { kind: "signed_out" };
      } catch {
        // Storage threw. The stored copy says whether it can be read.
      }
      return null;
    })(),
    SESSION_BUDGET_MS,
  );
  return live ?? readStoredSession();
}

/** The session saved in secure storage, read without refreshing it. */
async function readStoredSession(): Promise<SessionView> {
  const key = sessionStorageKey();
  if (!key) return { kind: "unknown" };
  try {
    const uid = storedSessionUserId(await SecureStoreAdapter.getItem(key));
    return uid ? { kind: "user", userId: uid } : { kind: "signed_out" };
  } catch {
    return { kind: "unknown" };
  }
}

// ── Handled tap ids ──────────────────────────────────────────────────────

async function readHandled(): Promise<string[]> {
  try {
    const raw = await AsyncStorage.getItem(HANDLED_KEY);
    const parsed = raw ? (JSON.parse(raw) as unknown) : [];
    return Array.isArray(parsed)
      ? parsed.filter((x): x is string => typeof x === "string")
      : [];
  } catch {
    // Unreadable: a tap could be queued a second time, which the server
    // dedupes by its idempotency key.
    return [];
  }
}

async function writeHandled(ids: string[]): Promise<void> {
  try {
    await AsyncStorage.setItem(HANDLED_KEY, JSON.stringify(ids));
  } catch {
    // Same as above: at worst a second copy the server dedupes.
  }
}

// ── The pass ─────────────────────────────────────────────────────────────

function withBudget<T>(work: Promise<T>, ms: number): Promise<T | null> {
  let timer: ReturnType<typeof setTimeout> | null = null;
  const late = new Promise<null>((resolve) => {
    timer = setTimeout(() => resolve(null), ms);
  });
  return Promise.race([work, late]).finally(() => {
    if (timer) clearTimeout(timer);
  });
}

async function sendQueued(): Promise<DrainResult | null> {
  const token = await getAccessToken();
  if (!token) return null;
  const result = await drainQueue(token);
  // drainQueue returns at once while another drain runs (the Clock screen's
  // sync); that one sends this punch too, so wait for it.
  await whenDrainIdle();
  return result;
}

type ToSettle = { tap: SurfaceTapV1; via: "queue" | "not_sent" };

async function onePass(): Promise<void> {
  const mod = getShiftSurface();
  const raw = parseInbox(await mod.readInbox());
  if (raw.length === 0) return;

  const session = await readSessionView();
  const [owner, stored, handledIds] = await Promise.all([
    getQueueOwner(),
    storedPunchIds(),
    readHandled(),
  ]);
  const plan = planInbox({
    taps: raw,
    session,
    queue: { owner, storedCount: stored.ids.length, ids: stored.ids },
    handledIds,
  });

  const parsed = new Map<string, SurfaceTapV1>();
  for (const entry of raw) {
    const tap = parseTap(entry);
    if (tap) parsed.set(tap.id, tap);
  }

  const toAck: string[] = [];
  const toSettle: ToSettle[] = [];
  const release: string[] = [];
  const queuedNow: SurfaceTapV1[] = [];
  const failed = new Set<string>();
  let dropIdless = false;
  let otherAccount = false;

  for (const d of plan.decisions) {
    if (d.action === "enqueue") {
      try {
        await enqueuePunch(buildSimplePunch(d.punch.kind, d.punch.input), d.tap.userId);
        queuedNow.push(d.tap);
        toAck.push(d.tap.id);
        toSettle.push({ tap: d.tap, via: "queue" });
      } catch (err) {
        // The queue could not be written. The tap stays in the inbox and is
        // tried again at the next pass; its surface goes stale meanwhile.
        failed.add(d.tap.id);
        release.push(d.tap.id);
        reportError(err, "shift-actions.enqueue");
      }
    } else if (d.action === "ack") {
      // Queued by an earlier pass that stopped before its ack: settle it
      // from the queue like a new one.
      toAck.push(d.id);
      const tap = parsed.get(d.id);
      if (tap) toSettle.push({ tap, via: "queue" });
    } else if (d.action === "drop") {
      if (d.reason === "other_user") otherAccount = true;
      if (d.id) {
        toAck.push(d.id);
        const tap = parsed.get(d.id);
        if (tap) toSettle.push({ tap, via: "not_sent" });
      } else {
        dropIdless = true;
      }
    } else {
      // keep: nothing more this pass. The surface stays pending, then says
      // "Open Clox to send it."
      release.push(d.id);
    }
  }

  if (queuedNow.length > 0) {
    await writeHandled(plan.handledIds.filter((id) => !failed.has(id)));
  }
  const userId = session.kind === "user" ? session.userId : null;
  for (const tap of queuedNow) void mod.signalTap(tap.id, "queued");
  if (userId && queuedNow.length > 0) {
    emit({
      type: "queued",
      userId,
      taps: queuedNow.map((t) => ({ id: t.id, kind: t.kind, tapMs: t.tapMs })),
    });
  }
  if (otherAccount) notice(SURFACE_APP_COPY.otherAccountTap);
  for (const id of release) void mod.signalTap(id, "done");
  if (toAck.length === 0 && !dropIdless) return;

  let drain: DrainResult | null = null;
  if (toSettle.some((s) => s.via === "queue")) {
    try {
      drain = await withBudget(sendQueued(), DRAIN_BUDGET_MS);
    } catch (err) {
      reportError(err, "shift-actions.drain");
    }
  }

  let after: { ids: string[]; held: string[] } | null = null;
  try {
    after = await storedPunchIds();
  } catch {
    after = null;
  }
  const settled: SettledTap[] = [];
  for (const s of toSettle) {
    let outcome: TapOutcome = "not_sent";
    if (s.via === "queue") {
      const found = tapOutcomeFrom({
        settled: settledPunchOutcome(s.tap.id),
        // Unreadable: it was queued, so read it as still waiting.
        stored: after ? after.ids.includes(s.tap.id) : true,
        held: after ? after.held.includes(s.tap.id) : false,
      });
      // "unknown": it left the queue in an earlier app session (the app
      // stopped between the send and this pass's ack). Clearing its pending
      // look is all that is safe; the Clock screen's next refresh shows the
      // server's state.
      outcome = found === "unknown" ? "not_sent" : found;
    }
    settled.push({ tap: s.tap, outcome });
  }

  // The shift is over, on the server or in the queue: the long shift
  // reminder goes now, whether or not the Clock screen is mounted.
  if (
    settled.some(
      (s) =>
        s.tap.kind === "out" &&
        (s.outcome === "sent" || s.outcome === "already" || s.outcome === "queued"),
    )
  ) {
    void cancelLongShiftReminders();
  }

  await runSurfaceOp("shift-actions.settle", async () => {
    await mod.ackTaps(toAck);
    const { snapshot, inbox } = await readNative();
    if (snapshot.platform === "none" || !snapshot.state) return;
    let list = settled;
    // A pending look whose tap has left the inbox without being settled here
    // (a malformed entry) would block the buttons for good. Clear it.
    const pending = snapshot.state.pendingTap;
    const owner = snapshot.state.ownerUserId;
    const stillSaved = inbox.some(
      (e) =>
        typeof e === "object" &&
        e !== null &&
        typeof (e as { id?: unknown }).id === "string" &&
        (e as { id: string }).id.toLowerCase() === pending?.id,
    );
    if (pending && owner && !stillSaved && !settled.some((s) => s.tap.id === pending.id)) {
      list = [
        ...settled,
        {
          tap: { id: pending.id, kind: pending.kind, tapMs: pending.tapMs, userId: owner },
          outcome: "not_sent",
        },
      ];
    }
    if (list.length === 0) return;
    const nowMs = Date.now();
    const tz = surfaceZone(snapshot.state, snapshot.state.ownerUserId);
    const { state, finalCard } = settleTaps(snapshot.state, list, nowMs, (ms) =>
      clockTextIn(ms, tz),
    );
    if (!state) return;
    const { apply } = planSurfaceApply({
      snapshot,
      inbox,
      next: state,
      nowMs,
      foreground: isForeground(),
      source: "settle",
      finalCard,
    });
    await applyNative(apply);
  });

  for (const id of toAck) void mod.signalTap(id, "done");
  emit({
    type: "settled",
    userId,
    drain,
    outcomes: settled.map((s) => ({ id: s.tap.id, kind: s.tap.kind, outcome: s.outcome })),
  });
}

let running: Promise<void> | null = null;
let again = false;

/**
 * Turn every saved tap into a queued punch and send it. Single-flight: a
 * call while a pass runs asks for one more pass after it (the Android
 * headless task and the onTap event can both arrive for one tap) and
 * resolves with it. Never throws.
 */
export function processSurfaceTaps(reason: string): Promise<void> {
  if (!hasNativeShiftSurface()) return Promise.resolve();
  if (running) {
    again = true;
    return running;
  }
  running = (async () => {
    try {
      do {
        again = false;
        await onePass();
      } while (again);
    } catch (err) {
      reportError(err, `shift-actions.pass.${reason}`);
    } finally {
      running = null;
    }
  })();
  return running;
}

// ── Wiring ───────────────────────────────────────────────────────────────

let installed = false;

/**
 * Called once from index.js, before the root component registers, so it
 * runs on every start: a normal launch, an iOS background launch for a
 * button, and the Android headless task. Listens for taps, looks at the
 * inbox now and at each return to the foreground.
 */
export function installShiftActions(): void {
  if (installed) return;
  installed = true;
  if (!hasNativeShiftSurface()) return;
  try {
    // The first listener makes native nudge once for a tap saved before the
    // JavaScript was listening.
    getShiftSurface().addListener("onTap", () => {
      void processSurfaceTaps("tap");
    });
  } catch (err) {
    reportError(err, "shift-actions.install");
  }
  AppState.addEventListener("change", (state) => {
    if (state === "active") void processSurfaceTaps("foreground");
  });
  void processSurfaceTaps("launch");
}

/**
 * The Android headless task (shift-surface.ts SHIFT_ACTION_TASK_NAME), which
 * every notification tap starts, in the running app or without a screen. It
 * joins a pass the onTap event already started. Its data names the tap just
 * saved; the pass reads the whole inbox either way. The service keeps the
 * process alive, and the JavaScript timers running, until this resolves, or
 * 30 seconds.
 */
export async function runShiftActionTask(): Promise<void> {
  await processSurfaceTaps("headless");
}
