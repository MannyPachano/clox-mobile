/**
 * The clock-in moment on the Clock screen: the check, the palette flip, the
 * undo offer, hold to clock out and the sync line. The timing and state rules
 * live here, pure (no React, no React Native, no AsyncStorage, no Intl), so a
 * plain node script can check them. ClockScreen and its small components
 * read every number and string from this file.
 */

/** How long the drawn check stays in the Clock in button before the screen
 *  flips to the on-shift palette. */
export const CHECK_MS = 500;
/** How long the check takes to draw (the mockup's 420 ms stroke). */
export const CHECK_DRAW_MS = 420;
/** The palette flip between the off-shift and on-shift screens. */
export const PALETTE_FLIP_MS = 700;

/** How long the undo offer stays on screen after the flip. */
export const UNDO_NOTICE_MS = 10_000;
/** With a screen reader on, the offer stays longer: finding and activating a
 *  button takes more than ten seconds when it is read out first. Still well
 *  inside the server's window below. The web's longest hold is the same. */
export const UNDO_NOTICE_SCREEN_READER_MS = 45_000;
/** The server undoes a clock-in only when it started this long ago or less
 *  (UNDO_CLOCK_IN_WINDOW_MS in the web repo's src/lib/undo-clock-in.ts). The
 *  phone applies the same limit, by its own clock, to a tap on the offer. */
export const UNDO_SERVER_WINDOW_MS = 60_000;
/** How long "Your clock-in was undone." stays up. */
export const UNDO_DONE_NOTE_MS = 4_000;
/** How long an undo waits for a send of the same clock-in that is already on
 *  the wire before it gives up and asks the worker to try again. */
export const UNDO_SEND_WAIT_MS = 10_000;
/** How long an undo waits for the server's answer. React Native's fetch has
 *  no timeout of its own. */
export const UNDO_REQUEST_TIMEOUT_MS = 10_000;

/** Rejects with an Error("timeout") when `p` has not settled in `ms`. */
export function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("timeout")), ms);
    p.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (err: unknown) => {
        clearTimeout(timer);
        reject(err instanceof Error ? err : new Error(String(err)));
      },
    );
  });
}

/** Hold to clock out: how long the button takes to fill. */
export const HOLD_TO_CLOCK_OUT_MS = 1_200;
/** After an early release, how long the label keeps saying "Keep holding". */
export const KEEP_HOLDING_MS = 2_000;
/** The longest the fill takes to run back to empty after an early release. */
export const HOLD_RESET_MAX_MS = 200;

/** Elapsed shift time as H:MM:SS, so a new shift starts at 0:00:00. Negative
 *  input (a tap time a moment ahead of the tick) reads as zero. */
export function formatElapsed(ms: number): string {
  const total = Math.floor((ms > 0 ? ms : 0) / 1000);
  const pad = (n: number) => (n < 10 ? `0${n}` : `${n}`);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  return `${h}:${pad(m)}:${pad(s)}`;
}

// ---------------------------------------------------------------------------
// The sync line
// ---------------------------------------------------------------------------

export type SyncLine =
  | { kind: "saved"; text: string }
  | { kind: "synced"; text: string }
  | { kind: "none" };

/**
 * The line under the buttons, from the queue's own counts (queue.ts
 * queuedCount and heldCount). A punch is "saved on this phone" until it
 * leaves the queue, and every punch has been sent once none are waiting.
 * Held punches keep their own line (the tappable one below), so with only
 * held punches on the phone this line is empty, as before.
 */
export function syncLine(counts: { pending: number; held: number }): SyncLine {
  if (counts.pending > 0) {
    return {
      kind: "saved",
      text:
        counts.pending === 1
          ? "Saved on this phone"
          : `${counts.pending} punches saved on this phone`,
    };
  }
  if (counts.held > 0) return { kind: "none" };
  return { kind: "synced", text: "All punches synced" };
}

// ---------------------------------------------------------------------------
// The undo offer
// ---------------------------------------------------------------------------

export type UndoOffer = {
  /** The clock-in's queue id, which is also the idempotency key it is sent
   *  with (api.ts clockIn) and the key the undo endpoint needs. */
  punchId: string;
  /** The clock-in's tap time (QueuedPunch.clientTime). */
  tappedAt: string;
  /** When the offer appears, after the check. */
  shownAtMs: number;
  /** How long it stays up (undoNoticeMs). */
  noticeMs: number;
};

export function undoNoticeMs(screenReaderOn: boolean): number {
  return screenReaderOn ? UNDO_NOTICE_SCREEN_READER_MS : UNDO_NOTICE_MS;
}

/** When the offer closes by itself. */
export function undoOfferClosesAt(
  offer: Pick<UndoOffer, "shownAtMs" | "noticeMs">,
): number {
  return offer.shownAtMs + offer.noticeMs;
}

/** Whole seconds left on the offer, for the countdown. */
export function undoSecondsLeft(
  offer: Pick<UndoOffer, "shownAtMs" | "noticeMs">,
  nowMs: number,
): number {
  const left = undoOfferClosesAt(offer) - nowMs;
  if (!Number.isFinite(left) || left <= 0) return 0;
  return Math.min(Math.ceil(left / 1000), Math.ceil(offer.noticeMs / 1000));
}

/**
 * True when a tap on the offer comes more than UNDO_SERVER_WINDOW_MS after
 * the clock-in. Timers stop while a phone sleeps, so the offer can still be
 * on screen when it wakes; the clock is checked at the tap. An unreadable
 * tap time fails closed.
 */
export function undoTooLate(tappedAt: string, nowMs: number): boolean {
  const age = nowMs - Date.parse(tappedAt);
  return !Number.isFinite(age) || age > UNDO_SERVER_WINDOW_MS;
}

/** What the queue holds for the clock-in being undone (queue.ts
 *  takeQueuedClockInForUndo), or null when it has left the queue. */
export type QueuedCopy = {
  /** A send of it was started in this app session. It may have reached the
   *  server even though the answer never came back. */
  attempted: boolean;
  /** A later punch (a break, a switch, a clock-out) depends on it. */
  hasLaterPunches: boolean;
};

/**
 * What an undo does.
 *   too_late           More than a minute after the tap. Nothing is removed.
 *   changed            A later punch belongs to this clock-in, so removing it
 *                      would orphan that punch. Nothing is removed.
 *   local              Still in the queue and never sent. Removing it from
 *                      the queue is the whole undo; the server never saw it.
 *   local_then_server  Still in the queue, but a send was started, so the
 *                      server may have it, and the phone is online. Remove it
 *                      from the queue first, so no later sync can send it,
 *                      then undo it on the server. The screen changes only
 *                      once the server answers. Its nothing_to_undo means the
 *                      send never landed, which is also a finished undo.
 *   server             It left the queue (sent and answered), so only the
 *                      server has it. Undo it there.
 *   offline            The server has it, or may have it, and the phone is
 *                      offline. Nothing is removed, so a clock-in still in
 *                      the queue is sent later as usual (the send is
 *                      idempotent), and the worker can try again online.
 *
 * The same rule as the web's planQueuedClockInUndo (web repo
 * src/lib/undo-clock-in.ts), plus "changed" for a queue that holds a later
 * punch of the same shift.
 */
export type UndoPlan =
  | "too_late"
  | "changed"
  | "local"
  | "local_then_server"
  | "server"
  | "offline";

export function planUndo(input: {
  tappedAt: string;
  nowMs: number;
  queued: QueuedCopy | null;
  online: boolean;
}): UndoPlan {
  if (undoTooLate(input.tappedAt, input.nowMs)) return "too_late";
  const q = input.queued;
  if (q) {
    if (q.hasLaterPunches) return "changed";
    if (!q.attempted) return "local";
    return input.online ? "local_then_server" : "offline";
  }
  return input.online ? "server" : "offline";
}

/** True when the plan takes the clock-in out of the queue. Only "local"
 *  returns the screen to Not clocked in straight away; after
 *  "local_then_server" the screen waits for the server's answer, because
 *  the send that was started may have landed. */
export function planRemovesLocalCopy(plan: UndoPlan): boolean {
  return plan === "local" || plan === "local_then_server";
}

/**
 * The offer after an undo attempt that asks the worker to try again (no
 * connection, no answer, a send still on the wire, a server error). The
 * auto-close timer does not run while an undo is busy, and a slow attempt
 * can outlast the offer's own time, so the offer starts over from now. It
 * never outlasts the server's window, measured from the tap time; an
 * unreadable tap time closes it.
 */
export function rearmUndoOffer(offer: UndoOffer, nowMs: number): UndoOffer {
  const left = UNDO_SERVER_WINDOW_MS - (nowMs - Date.parse(offer.tappedAt));
  const noticeMs = Number.isFinite(left)
    ? Math.max(0, Math.min(offer.noticeMs, left))
    : 0;
  return { ...offer, shownAtMs: nowMs, noticeMs };
}

/** The server's refusals (the web repo's UndoClockInRefusal, minus
 *  nothing_to_undo, which the phone counts as done). */
export const UNDO_REFUSAL_CODES = [
  "too_late",
  "approved",
  "locked",
  "switched_project",
  "had_break",
  "changed",
] as const;

export type UndoAnswer =
  | "done"
  | "refused"
  | "unauthorized"
  | "retry"
  | "unavailable"
  | "failed";

/**
 * Sorts an answer from POST /api/mobile/v1/undo-clock-in.
 *   done          Undone, or there was nothing to undo (a repeat, or a punch
 *                 that never landed): either way no clock-in is running
 *                 under this key.
 *   refused       The server has it and will not undo it (409).
 *   unauthorized  The session expired (401).
 *   retry         Rate limited or a server error: worth another try.
 *   unavailable   The route does not exist on this server (404): the web
 *                 release with the undo endpoint is not deployed.
 *   failed        Anything else.
 */
export function classifyUndoAnswer(
  res: { ok: true } | { ok: false; status: number; error: string },
): UndoAnswer {
  if (res.ok) return "done";
  if (res.error === "nothing_to_undo") return "done";
  if ((UNDO_REFUSAL_CODES as readonly string[]).includes(res.error)) {
    return "refused";
  }
  if (res.status === 401) return "unauthorized";
  if (res.status === 404) return "unavailable";
  if (res.status === 429 || res.status >= 500) return "retry";
  return "failed";
}

/** The words a worker reads. Complete sentences, no dashes. `prompt`
 *  through `refusals` follow the web's UNDO_CLOCK_IN_COPY, except `button`,
 *  which names the action in full. The button has no separate accessibility
 *  label, so its spoken name is always the text on it. */
export const UNDO_COPY = {
  prompt: "Tapped by mistake?",
  button: "Undo clock-in",
  busy: "Undoing…",
  done: "Your clock-in was undone. No time was added to your timesheet.",
  offline:
    "You're offline, so this clock-in can't be undone right now. Try again when you're back online, or clock out.",
  unreachable:
    "Couldn't reach Clox to undo the clock-in. Check your connection and try again.",
  unauthorized: "Your session expired. Sign in again to undo the clock-in.",
  unknown: "Couldn't undo the clock-in. Try again.",
  refusals: {
    too_late:
      "It's been more than a minute, so this clock-in can't be undone. Clock out instead, and ask your manager to remove the shift if it shouldn't count.",
    approved: "This shift is already approved, so it can't be undone.",
    locked: "This shift is in a closed pay period, so it can't be undone.",
    switched_project:
      "You switched projects on this shift, so it can't be undone. Clock out instead.",
    had_break:
      "You took a break on this shift, so it can't be undone. Clock out instead.",
    changed:
      "This shift was changed after you clocked in, so it can't be undone. Clock out instead.",
  } as Record<string, string>,
  unavailable:
    "Undo isn't available yet. Clock out instead, and ask your manager to remove the shift if it shouldn't count.",
  /** The phone removed its copy, and later the server refused to undo the
   *  one it already had, so the shift comes back on screen. */
  reachedServer:
    "Your clock-in reached Clox before you undid it, so the shift is still running. Clock out, and ask your manager to remove the shift if it shouldn't count.",
  /** The phone removed its copy after a send had started, and the server's
   *  final answer was neither done nor a refusal (a server without the undo
   *  route, a bad request). The send may or may not have landed. */
  unconfirmed:
    "Clox couldn't confirm the undo. If your shift shows as running, clock out and ask your manager to remove it.",
  /** As above, but no final answer yet (no connection, a server error). The
   *  phone asks again each time it syncs. */
  pending:
    "The undo isn't confirmed yet. This phone asks Clox again each time it syncs. If your shift shows as running, clock out and ask your manager to remove it.",
  /** Read out by a screen reader when the offer appears. */
  announceOffer: `You're clocked in. If you tapped by mistake, Undo clock-in is on screen for ${
    UNDO_NOTICE_SCREEN_READER_MS / 1000
  } seconds.`,
  announceClockedIn: "You're clocked in.",
} as const;

/** The banner for an answer that did not finish the undo. */
export function undoFailureMessage(answer: UndoAnswer, code: string): string {
  switch (answer) {
    case "refused":
      return UNDO_COPY.refusals[code] ?? UNDO_COPY.unknown;
    case "unauthorized":
      return UNDO_COPY.unauthorized;
    case "unavailable":
      return UNDO_COPY.unavailable;
    default:
      return UNDO_COPY.unknown;
  }
}

/** True when an answer to a server undo the phone still owes (the local copy
 *  is already gone) is final, so the phone can stop asking. */
export function owedUndoSettled(answer: UndoAnswer): boolean {
  return answer !== "retry" && answer !== "unauthorized";
}

/**
 * What a server answer means for a clock-in the phone has already taken out
 * of its queue after a send of it had started (plan local_then_server, and
 * the undo the phone still owes after one). `null` is no answer at all.
 *   done     No clock-in runs under this key on the server either.
 *   final    Any other final answer: the server's state stands, and the
 *            next refresh shows it.
 *   pending  No final answer yet: ask again on the next sync.
 */
export function owedUndoOutcome(
  answer: UndoAnswer | null,
): "done" | "final" | "pending" {
  if (answer === null || !owedUndoSettled(answer)) return "pending";
  return answer === "done" ? "done" : "final";
}

// ---------------------------------------------------------------------------
// Hold to clock out
// ---------------------------------------------------------------------------

/**
 *   idle      Not touched, or the "Keep holding" nudge has timed out.
 *   holding   Pressed; the fill is running.
 *   released  Let go before the fill finished; the fill runs back to empty.
 *   done      The fill finished; the clock-out is on its way.
 */
export type HoldPhase = "idle" | "holding" | "released" | "done";

export function holdLabel(phase: HoldPhase): string {
  switch (phase) {
    case "holding":
    case "released":
      return "Keep holding";
    case "done":
      return "Clocking out";
    default:
      return "Hold to clock out";
  }
}

/** How full the button is after holding for `heldMs`, from 0 to 1. */
export function holdProgressAt(heldMs: number): number {
  if (!Number.isFinite(heldMs) || heldMs <= 0) return 0;
  return Math.min(1, heldMs / HOLD_TO_CLOCK_OUT_MS);
}

/** What a release does: a finished fill stays done, anything short of it
 *  resets. */
export function holdPhaseOnRelease(completed: boolean): HoldPhase {
  return completed ? "done" : "released";
}

/** How long the fill takes to run back to empty from `progress`. */
export function holdResetMs(progress: number): number {
  const p = Number.isFinite(progress) ? Math.min(1, Math.max(0, progress)) : 0;
  return Math.round(p * HOLD_RESET_MAX_MS);
}

// ---------------------------------------------------------------------------
// The palette flip
// ---------------------------------------------------------------------------

/** How long the flip between palettes runs. Reduce Motion turns it off, and
 *  there is no flip at all when the theme is set to always light or always
 *  dark (both palettes are the same then). */
export function paletteFlipMs(reduceMotion: boolean): number {
  return reduceMotion ? 0 : PALETTE_FLIP_MS;
}
