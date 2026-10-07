// Two-step verification on the phone: the pure parts. No imports, so the
// rules can be checked with a plain node script (scripts/mfa-check.mjs).
//
// The server (web repo src/lib/mobile-auth.ts) refuses a password-only token
// on an account with 2FA turned on: HTTP 401, error "mfa_required". The app
// answers that with the 6-digit code step (screens/MfaScreen.tsx), never by
// signing the person out, and the punch queue keeps its punches on any 401
// (queue.ts), so they are sent once the code is in.

/** The server's error code for a password-only token on a 2FA account. */
export const MFA_REQUIRED = "mfa_required";

/** True for the server's "enter your code first" answer. */
export function isMfaRequired(status: number, error: string): boolean {
  return status === 401 && error === MFA_REQUIRED;
}

// ── The signal from api.ts to App ─────────────────────────────────────────

type Listener = () => void;
const listeners = new Set<Listener>();

/** App listens for the whole session. Returns the unsubscribe. */
export function onMfaRequired(listener: Listener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** Every mobile-API answer passes through here (api.ts request). */
export function noteApiAnswer(status: number, error: string): void {
  if (!isMfaRequired(status, error)) return;
  for (const listener of Array.from(listeners)) {
    try {
      listener();
    } catch {
      // One listener failing must not stop the others.
    }
  }
}

// ── The session's assurance level ─────────────────────────────────────────

/**
 * The `aal` claim of a Supabase access token: "aal1" after a password,
 * "aal2" after the code. Null when the token has no readable claim. Read
 * locally, so it works offline; the server checks the signature.
 */
export function tokenAal(token: string | null | undefined): string | null {
  const part = token?.split(".")[1];
  if (!part) return null;
  try {
    const b64 = part
      .replace(/-/g, "+")
      .replace(/_/g, "/")
      .padEnd(Math.ceil(part.length / 4) * 4, "=");
    const claims = JSON.parse(atob(b64)) as { aal?: unknown } | null;
    return typeof claims?.aal === "string" ? claims.aal : null;
  } catch {
    return null;
  }
}

// ── When the code step is decided ────────────────────────────────────────

/**
 * What App does about the second step when it has a session:
 *   none           Carry on. A session at aal2 needs nothing, and so does a
 *                  session restored at launch with no code step pending.
 *   code_step      Show the code step now, from local state only: a code
 *                  step was left open for this user (the app closed on it).
 *   check_factors  Ask the auth server for the user's factors, before any
 *                  app screen shows. Only right after a password sign-in on
 *                  this phone, when the session is brand new.
 *
 * A restored session is never checked over the network. The auth server
 * deletes every password-only session of a user each time a factor is
 * verified, so a phone signed in before 2FA was turned on holds a session
 * that no longer exists, and GET /user on it (what listFactors calls) makes
 * supabase-js delete the stored session and sign the app out on the spot,
 * under screens that are still mounting. Update b4e947d3 (1.4.0) did that
 * at launch on the one phone with 2FA, which then crashed and rolled back.
 * A live password-only session is caught by the server's mfa_required
 * answer instead.
 */
export type CodeStepPlan = "none" | "code_step" | "check_factors";

export function planCodeStep(input: {
  /** The session token's aal claim (tokenAal). */
  aal: string | null;
  /** A password sign-in on this phone is waiting for its factor check. */
  passwordSignIn: boolean;
  /** The user a code step was left open for, if any. */
  pendingUserId: string | null;
  userId: string;
}): CodeStepPlan {
  if (input.aal === "aal2") return "none";
  if (input.pendingUserId === input.userId) return "code_step";
  if (input.passwordSignIn) return "check_factors";
  return "none";
}

/** A complete code: exactly six digits. */
export function isSixDigitCode(code: string): boolean {
  return /^\d{6}$/.test(code);
}

// ── Errors from supabase.auth.mfa ─────────────────────────────────────────

export type CodeErrorKind =
  | "wrong_code"
  | "rate_limited"
  | "offline"
  | "session_ended"
  | "unknown";

type AuthErrorLike = {
  name?: unknown;
  status?: unknown;
  code?: unknown;
  message?: unknown;
};

/** Sorts an error from listFactors, challenge or verify into what the code
 *  step tells the person. */
export function classifyCodeError(err: unknown): CodeErrorKind {
  const e = (err ?? {}) as AuthErrorLike;
  const name = typeof e.name === "string" ? e.name : "";
  const status = typeof e.status === "number" ? e.status : 0;
  const code = typeof e.code === "string" ? e.code : "";
  const message = typeof e.message === "string" ? e.message : "";
  if (
    name === "AuthRetryableFetchError" ||
    /network request failed|failed to fetch|fetch failed/i.test(message)
  ) {
    return "offline";
  }
  if (code === "over_request_rate_limit" || status === 429) {
    return "rate_limited";
  }
  if (
    code === "mfa_verification_failed" ||
    code === "mfa_challenge_expired" ||
    status === 422
  ) {
    return "wrong_code";
  }
  if (
    name === "AuthSessionMissingError" ||
    code === "session_not_found" ||
    code === "session_expired" ||
    code === "refresh_token_not_found" ||
    code === "bad_jwt" ||
    status === 401 ||
    status === 403
  ) {
    return "session_ended";
  }
  return "unknown";
}

// ── Words ─────────────────────────────────────────────────────────────────

export const MFA_COPY = {
  eyebrow: "Two-step verification",
  title: "Enter your code",
  body: "Open your authenticator app and enter the 6-digit code for Clox.",
  placeholder: "6-digit code",
  verify: "Verify",
  recovery:
    "Lost your authenticator app? Use a recovery code at app.getclox.com/signin.",
  recoveryUrl: "https://app.getclox.com/signin",
  signOut: "Sign out",
  tryAgain: "Try again",
  sending: "Sending the punches saved on this phone.",
  notSix: "Enter the 6 digits from your authenticator app.",
  loadFailed:
    "Clox could not load your two-step settings. Check your connection, then try again.",
  errors: {
    wrong_code:
      "That code did not work. Enter the current code from your authenticator app.",
    rate_limited: "Too many tries. Wait a few minutes, then try again.",
    offline: "You're offline. Connect to the internet to enter your code.",
    session_ended: "This sign-in has ended. Sign out, then sign in again.",
    unknown: "Clox could not check the code. Try again.",
  } satisfies Record<CodeErrorKind, string>,
  /** The question before signing out from the code step, when punches are
   *  waiting: signing out clears the queue, and they can't be sent without
   *  the code. */
  signOutTitle: "Sign out?",
  signOutWithPunches(count: number): string {
    return count === 1
      ? "1 punch saved on this phone has not been sent. Signing out deletes it. Enter your code first to send it."
      : `${count} punches saved on this phone have not been sent. Signing out deletes them. Enter your code first to send them.`;
  },
  cancel: "Cancel",
  /** Title of the note when punches sent after the code were refused. */
  sentTitle: "Punches on this phone",
} as const;
