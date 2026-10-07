// Two-step verification on the phone. Run: node scripts/mfa-check.mjs
//
// Loads the REAL queue.ts and api.ts (React Native modules swapped for the
// fakes in scripts/test-fakes) against a fake server, and checks that a
// punch queued while the server answers 401 "mfa_required" stays on the
// phone, raises the code-step signal, and is sent once the code is in. Also
// checks the pure rules in src/lib/mfa.ts.
import { Buffer } from "node:buffer";
import { register } from "node:module";

register("./test-fakes/hooks.mjs", import.meta.url);

const storage = (await import("./test-fakes/async-storage.mjs")).default;
const queue = await import("../src/queue.ts");
const api = await import("../src/api.ts");
const mfa = await import("../src/lib/mfa.ts");

let pass = 0;
let fail = 0;
const eq = (got, want, msg) => {
  if (JSON.stringify(got) === JSON.stringify(want)) pass++;
  else {
    fail++;
    console.log("FAIL:", msg, "\n  got ", JSON.stringify(got), "\n  want", JSON.stringify(want));
  }
};

// ── The fake server ───────────────────────────────────────────────────────
let answer = { status: 200, body: { ok: true } };
const sent = [];
globalThis.fetch = async (url, init) => {
  sent.push({
    url: String(url),
    auth: init?.headers?.Authorization ?? null,
    body: init?.body ? JSON.parse(init.body) : null,
  });
  return new Response(JSON.stringify(answer.body), {
    status: answer.status,
    headers: { "Content-Type": "application/json" },
  });
};
const answerWith = (status, body) => {
  answer = { status, body };
};

// What the phone has stored, read the way queue.ts stores it (the same on
// main and release/1.3, which lacks some of main's queue helpers).
const storedIds = async () =>
  JSON.parse((await storage.getItem("clox.punch.queue.v1")) ?? "[]").map((p) => p.id);
// How a punch left the queue (main only: release/1.3 does not record it).
const outcome = (id) =>
  queue.settledPunchOutcome ? queue.settledPunchOutcome(id) : "n/a";
const outcomeOr = (want) => (queue.settledPunchOutcome ? want : "n/a");

let signals = 0;
mfa.onMfaRequired(() => {
  signals += 1;
});

let n = 0;
function punch(kind) {
  n += 1;
  return {
    id: `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`,
    kind,
    clientTime: new Date().toISOString(),
    projectId: null,
    taskId: null,
    note: null,
    selfie: null,
    latitude: null,
    longitude: null,
    accuracyM: null,
    mocked: null,
  };
}

async function reset() {
  storage._reset();
  sent.length = 0;
  signals = 0;
}

const MFA = { error: "mfa_required" };

// ── 1. A queued punch survives an mfa_required answer ─────────────────────
await reset();
const clockIn = punch("in");
await queue.enqueuePunch(clockIn, "user-1");
answerWith(401, MFA);
let r = await queue.drainQueue("password-only-token");
eq([r.synced, r.remaining, r.held], [0, 1, 0], "mfa_required: nothing synced, the punch is still waiting");
eq(r.errors, [], "mfa_required: no error banner (the code step handles it)");
eq(await storedIds(), [clockIn.id], "mfa_required: the same punch is still stored");
eq(outcome(clockIn.id), outcomeOr(null), "mfa_required: the punch is not recorded as refused");
eq(signals, 1, "mfa_required: the code-step signal fired once");
eq(sent.length, 1, "mfa_required: one request was made");

// A second drain while the code is still not in: still kept.
r = await queue.drainQueue("password-only-token");
eq(r.remaining, 1, "mfa_required twice: still kept");

// The code goes in; the next drain (aal2 token) sends it.
sent.length = 0;
answerWith(200, { ok: true });
r = await queue.drainQueue("aal2-token");
eq([r.synced, r.remaining], [1, 0], "after the code: the punch is sent");
eq(sent.map((s) => s.auth), ["Bearer aal2-token"], "after the code: sent under the new token");
eq(sent[0]?.body?.idempotencyKey, clockIn.id, "after the code: same idempotency key");
eq(outcome(clockIn.id), outcomeOr("sent"), "after the code: recorded as sent");
eq(await storedIds(), [], "after the code: queue empty");

// ── 2. Order is kept: the drain stops at the first mfa_required ───────────
await reset();
const a = punch("in");
const b = punch("out");
await queue.enqueuePunch(a, "user-1");
await queue.enqueuePunch(b, "user-1");
answerWith(401, MFA);
r = await queue.drainQueue("password-only-token");
eq([r.synced, r.remaining], [0, 2], "two punches: both kept");
eq(sent.length, 1, "two punches: the drain stopped after the first refusal");
eq(await storedIds(), [a.id, b.id], "two punches: order kept");
answerWith(200, { ok: true });
r = await queue.drainQueue("aal2-token");
eq([r.synced, r.remaining], [2, 0], "two punches: both sent after the code");

// ── 3. Why the server must answer 401, never 403 ──────────────────────────
await reset();
const dropped = punch("in");
await queue.enqueuePunch(dropped, "user-1");
answerWith(403, MFA);
r = await queue.drainQueue("password-only-token");
eq(r.remaining, 0, "a 403 drops the punch (so mfa_required must be a 401)");
eq(outcome(dropped.id), outcomeOr("refused"), "a 403 is recorded as refused");
eq(signals, 0, "a 403 does not raise the code step");

// An expired session (401 unauthorized) keeps the punch without the step.
await reset();
const expired = punch("in");
await queue.enqueuePunch(expired, "user-1");
answerWith(401, { error: "unauthorized" });
r = await queue.drainQueue("expired-token");
eq([r.remaining, signals], [1, 0], "401 unauthorized: kept, no code step");

// ── 4. Every API call raises the signal, not only punches ────────────────
await reset();
answerWith(401, MFA);
const status = await api.getStatus("password-only-token");
eq([status.ok, status.status, status.error], [false, 401, "mfa_required"], "getStatus passes the answer back");
eq(signals, 1, "getStatus mfa_required raises the signal");
const roster = await api.getManagerRoster("password-only-token");
eq([roster.status, roster.error, signals], [401, "mfa_required", 2], "a manager call raises it too");

// ── 5. The pure rules ─────────────────────────────────────────────────────
const b64url = (o) => Buffer.from(JSON.stringify(o)).toString("base64url");
const jwt = (claims) => `${b64url({ alg: "HS256" })}.${b64url(claims)}.sig`;
eq(mfa.tokenAal(jwt({ aal: "aal1" })), "aal1", "tokenAal reads aal1");
eq(mfa.tokenAal(jwt({ aal: "aal2", email: "zoë@example.com" })), "aal2", "tokenAal reads aal2 beside non-ASCII claims");
eq(mfa.tokenAal(jwt({ sub: "x" })), null, "tokenAal: no claim");
eq([mfa.tokenAal(null), mfa.tokenAal(""), mfa.tokenAal("abc"), mfa.tokenAal("a.!!!.c")], [null, null, null, null], "tokenAal: unreadable tokens");

eq(["123456", "12345", "1234567", "12a456", " 123456"].map(mfa.isSixDigitCode), [true, false, false, false, false], "isSixDigitCode");

eq(mfa.isMfaRequired(401, "mfa_required"), true, "isMfaRequired: 401");
eq([mfa.isMfaRequired(403, "mfa_required"), mfa.isMfaRequired(401, "unauthorized")], [false, false], "isMfaRequired: others");

const classify = mfa.classifyCodeError;
eq(classify({ name: "AuthApiError", status: 422, code: "mfa_verification_failed" }), "wrong_code", "wrong code");
eq(classify({ name: "AuthApiError", status: 429, code: "over_request_rate_limit" }), "rate_limited", "rate limited");
eq(classify({ name: "AuthRetryableFetchError", status: 0, message: "Network request failed" }), "offline", "offline (supabase)");
eq(classify(new TypeError("Network request failed")), "offline", "offline (fetch)");
eq(classify({ name: "AuthSessionMissingError", status: 400 }), "session_ended", "session missing");
eq(classify({ name: "AuthApiError", status: 403, code: "session_not_found" }), "session_ended", "session revoked (recovery code used on the web)");
eq(classify({ name: "AuthApiError", status: 500 }), "unknown", "server error");
eq(classify(null), "unknown", "nothing");

// The words follow the house rules: no em or en dashes, no exclamation marks.
const words = [];
const collect = (v) => {
  if (typeof v === "string") words.push(v);
  else if (typeof v === "function") words.push(v(1), v(3));
  else if (v && typeof v === "object") Object.values(v).forEach(collect);
};
collect(mfa.MFA_COPY);
eq(words.filter((w) => /[–—!]/.test(w)), [], "copy: no dashes or exclamation marks");
eq(mfa.MFA_COPY.recovery, "Lost your authenticator app? Use a recovery code at app.getclox.com/signin.", "copy: the recovery line");

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
