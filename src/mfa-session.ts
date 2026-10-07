import { classifyCodeError, type CodeErrorKind } from "./lib/mfa";
import { supabase } from "./supabase";

// Two-step verification through supabase.auth.mfa, the same calls the web's
// /verify-2fa page makes (web repo src/components/mfa-challenge.tsx).

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

// Users found to have no verified factor in this app session. listFactors is
// a network round trip (GET /user), so it is asked once per user, not at
// every token refresh. 2FA turned on later in the session is caught by the
// server's mfa_required answer instead.
const noFactor = new Set<string>();

/**
 * Whether this signed-in user has a verified factor, asked of the auth
 * server. "unknown" when it can't be reached in time: the app then carries
 * on, and the server's mfa_required answer brings up the code step once it
 * can be reached.
 */
export async function secondFactorNeeded(
  userId: string,
): Promise<"needed" | "clear" | "unknown"> {
  if (noFactor.has(userId)) return "clear";
  try {
    const res = await withBudget(supabase.auth.mfa.listFactors(), CHECK_BUDGET_MS);
    if (!res || res.error || !res.data) return "unknown";
    const verified = res.data.all.some((f) => f.status === "verified");
    if (!verified) noFactor.add(userId);
    return verified ? "needed" : "clear";
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

/** Forget the cached answers, at sign-out. */
export function clearSecondFactorCache(): void {
  noFactor.clear();
}
