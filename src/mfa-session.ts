import AsyncStorage from "@react-native-async-storage/async-storage";

import { classifyCodeError, type CodeErrorKind } from "./lib/mfa";
import { supabase } from "./supabase";

// Two-step verification through supabase.auth.mfa, the same calls the web's
// /verify-2fa page makes (web repo src/components/mfa-challenge.tsx).
//
// listFactors calls GET /user. On a session the auth server has deleted, that
// makes supabase-js delete the stored session and sign the app out at once,
// so it is only called on a session known to be alive: right after a password
// sign-in on this phone, and from the code step (lib/mfa.ts planCodeStep).

/** How long the sign-in check may take before the app carries on. */
const CHECK_BUDGET_MS = 8_000;

function withBudget<T>(work: Promise<T>, ms: number): Promise<T | null> {
  let timer: ReturnType<typeof setTimeout> | null = null;
  const late = new Promise<null>((resolve) => {
    timer = setTimeout(() => resolve(null), ms);
  });
  return Promise.race([work, late]).finally(() => {
    if (timer) clearTimeout(timer);
  });
}

// ── A password sign-in waiting for its factor check ──────────────────────

/** Sign-ins older than this no longer count as just made. */
const SIGN_IN_WINDOW_MS = 5 * 60_000;
let passwordSignInAt: number | null = null;

/** LoginScreen calls this just before signInWithPassword. */
export function notePasswordSignIn(): void {
  passwordSignInAt = Date.now();
}

/** True between a password sign-in on this phone and its factor check. */
export function passwordSignInOpen(): boolean {
  return (
    passwordSignInAt !== null && Date.now() - passwordSignInAt < SIGN_IN_WINDOW_MS
  );
}

/** The check is done, or the sign-in failed. */
export function closePasswordSignIn(): void {
  passwordSignInAt = null;
}

// ── A code step left open ─────────────────────────────────────────────────

// The user a code step is open for, kept across launches so a phone closed
// on the code step asks again at the next start without a network check.
const PENDING_KEY = "clox.mfa.code-step.v1";

export async function readCodeStepPending(): Promise<string | null> {
  try {
    return await AsyncStorage.getItem(PENDING_KEY);
  } catch {
    return null;
  }
}

export async function writeCodeStepPending(userId: string): Promise<void> {
  try {
    await AsyncStorage.setItem(PENDING_KEY, userId);
  } catch {
    // Worst case the next cold start does not ask by itself; the server's
    // mfa_required answer still brings the step up.
  }
}

export async function clearCodeStepPending(): Promise<void> {
  try {
    await AsyncStorage.removeItem(PENDING_KEY);
  } catch {
    // A stale marker only brings up the code step, which then finds the
    // session at aal2 or 2FA off and closes.
  }
}

// ── Calls to the auth server ──────────────────────────────────────────────

/**
 * Whether the user who just signed in with a password has a verified factor.
 * "unknown" when the auth server can't be reached in time: the app then
 * carries on, and the server's mfa_required answer brings up the code step.
 * Call it only on a session from a password sign-in on this phone.
 */
export async function secondFactorNeeded(): Promise<
  "needed" | "clear" | "unknown"
> {
  try {
    const res = await withBudget(supabase.auth.mfa.listFactors(), CHECK_BUDGET_MS);
    if (!res || res.error || !res.data) return "unknown";
    return res.data.all.some((f) => f.status === "verified")
      ? "needed"
      : "clear";
  } catch {
    return "unknown";
  }
}

export type FactorLookup =
  | { kind: "found"; factorId: string }
  /** No verified factor: 2FA was turned off, so no code is needed. */
  | { kind: "none" }
  | { kind: "error"; error: CodeErrorKind | "load_failed" };

/** The verified authenticator-app factor the code is checked against. */
export async function findVerifiedTotp(): Promise<FactorLookup> {
  try {
    const { data, error } = await supabase.auth.mfa.listFactors();
    if (error || !data) {
      const kind = classifyCodeError(error);
      return { kind: "error", error: kind === "unknown" ? "load_failed" : kind };
    }
    const totp = data.totp.find((f) => f.status === "verified");
    if (totp) return { kind: "found", factorId: totp.id };
    // A verified factor of another kind would still make the server ask for
    // the second step, which this screen can't answer. Clox only offers
    // authenticator apps, so this is a load failure, not "no 2FA".
    if (data.all.some((f) => f.status === "verified")) {
      return { kind: "error", error: "load_failed" };
    }
    return { kind: "none" };
  } catch (err) {
    const kind = classifyCodeError(err);
    return { kind: "error", error: kind === "unknown" ? "load_failed" : kind };
  }
}

/**
 * Check a 6-digit code. On success supabase-js stores the new aal2 session
 * and tells App through onAuthStateChange, so every later request carries it.
 */
export async function verifyTotpCode(
  factorId: string,
  code: string,
): Promise<{ ok: true } | { ok: false; error: CodeErrorKind }> {
  try {
    const { error } = await supabase.auth.mfa.challengeAndVerify({
      factorId,
      code,
    });
    if (error) return { ok: false, error: classifyCodeError(error) };
    return { ok: true };
  } catch (err) {
    return { ok: false, error: classifyCodeError(err) };
  }
}
