/**
 * Pure decision logic for the offline app lock — no imports, no I/O, so it runs
 * anywhere (and is verified by scripts/lock-policy-check.mjs). app-lock.ts wraps
 * these with SecureStore + expo-crypto.
 */

/** Digits required in a lock PIN. Six, not four: 100x the space for one extra tap. */
export const PIN_LENGTH = 6;

/** Wrong tries before the lock gives up and forces online re-authentication. */
export const MAX_FAILS_BEFORE_REAUTH = 10;

export type AttemptState = {
  fails: number;
  /** Epoch ms until which PIN entry is refused, or null when not timed out. */
  lockUntil: number | null;
};

export type VerifyOutcome =
  | { kind: "ok" }
  | { kind: "wrong"; failsLeft: number }
  | { kind: "locked_out"; retryAt: number }
  | { kind: "must_reauth" };

/**
 * Cooldown imposed AFTER reaching `fails` wrong entries. The first few misses
 * are free (fat fingers on a 6-digit pad), then it escalates, then it gives up.
 */
export function escalationDelayMs(fails: number): number {
  if (fails < 5) return 0;
  if (fails === 5) return 30_000;
  if (fails === 6) return 60_000;
  if (fails === 7) return 120_000;
  if (fails === 8) return 300_000;
  return 600_000; // 9 (10 triggers must_reauth before we get here)
}

/** True while a prior failure's cooldown is still in effect. */
export function isLockedOut(state: AttemptState, now: number): boolean {
  return state.lockUntil != null && now < state.lockUntil;
}

/**
 * Fold one verify attempt into the attempt state and say what the UI should do.
 * Pure: caller supplies the current state, whether the PIN matched, and `now`.
 */
export function applyAttempt(
  state: AttemptState,
  matched: boolean,
  now: number,
): { next: AttemptState; outcome: VerifyOutcome } {
  if (isLockedOut(state, now)) {
    return {
      next: state,
      outcome: { kind: "locked_out", retryAt: state.lockUntil as number },
    };
  }
  if (matched) {
    return { next: { fails: 0, lockUntil: null }, outcome: { kind: "ok" } };
  }
  const fails = state.fails + 1;
  if (fails >= MAX_FAILS_BEFORE_REAUTH) {
    return { next: { fails, lockUntil: null }, outcome: { kind: "must_reauth" } };
  }
  const delay = escalationDelayMs(fails);
  const lockUntil = delay > 0 ? now + delay : null;
  return {
    next: { fails, lockUntil },
    outcome:
      delay > 0
        ? { kind: "locked_out", retryAt: lockUntil as number }
        : { kind: "wrong", failsLeft: MAX_FAILS_BEFORE_REAUTH - fails },
  };
}
