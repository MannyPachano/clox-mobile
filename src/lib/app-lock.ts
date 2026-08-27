import * as Crypto from "expo-crypto";
import * as SecureStore from "expo-secure-store";

import {
  applyAttempt,
  isLockedOut,
  MAX_FAILS_BEFORE_REAUTH,
  PIN_LENGTH,
  type AttemptState,
  type VerifyOutcome,
} from "./lock-policy";

/**
 * Offline app lock: a local PIN (and optional biometric) that re-opens a
 * retained Supabase session without a network round-trip.
 *
 * Threat model, stated plainly so nobody mistakes this for more than it is.
 * The Supabase session is already encrypted at rest in the device keychain
 * (see secure-storage.ts). This lock is a UI gate in front of a phone whose
 * owner has already unlocked the OS — it stops a coworker who grabs an unlocked
 * handset from clocking in as someone else. It is NOT a cryptographic seal on
 * the session data. Given that, the PIN is stored as a salted SHA-256 hash
 * (never plaintext) and the real brute-force defense is the escalating lockout
 * plus a hard fall-back to online re-auth after enough misses. We do not stretch
 * the hash with many iterations: it would add latency on every unlock for no
 * real gain against an attacker who, to read the hash at all, has already
 * defeated the keychain (and with it the session itself).
 *
 * All logic that decides lock/allow is pure and injectable (now(), the stored
 * state) so it can be unit-checked without expo modules; only setup/verify touch
 * SecureStore + expo-crypto.
 */

const PIN_KEY = "clox.lock.v1";
const IDENTITY_KEY = "clox.lock.identity.v1";
const ATTEMPTS_KEY = "clox.lock.attempts.v1";

export { PIN_LENGTH, MAX_FAILS_BEFORE_REAUTH };
export type { AttemptState, VerifyOutcome };

export type LockIdentity = {
  userId: string;
  email: string | null;
  displayName: string | null;
  role: string | null;
};

type StoredLock = {
  salt: string;
  hash: string;
  biometric: boolean;
  createdAt: number;
};

// ── Hashing ──────────────────────────────────────────────────────────────────

async function hashPin(pin: string, salt: string): Promise<string> {
  return Crypto.digestStringAsync(
    Crypto.CryptoDigestAlgorithm.SHA256,
    `${salt}:${pin}`,
  );
}

function randomSalt(): string {
  const bytes = Crypto.getRandomBytes(16);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

// ── SecureStore-backed state ─────────────────────────────────────────────────

async function readJson<T>(key: string): Promise<T | null> {
  try {
    const raw = await SecureStore.getItemAsync(key);
    return raw ? (JSON.parse(raw) as T) : null;
  } catch {
    return null;
  }
}

async function writeJson(key: string, value: unknown): Promise<void> {
  await SecureStore.setItemAsync(key, JSON.stringify(value));
}

async function readAttempts(): Promise<AttemptState> {
  return (await readJson<AttemptState>(ATTEMPTS_KEY)) ?? { fails: 0, lockUntil: null };
}

export type LockStatus = {
  configured: boolean;
  biometric: boolean;
  identity: LockIdentity | null;
};

/** Snapshot of the lock's public state, safe to read on every cold start. */
export async function getLockStatus(): Promise<LockStatus> {
  const lock = await readJson<StoredLock>(PIN_KEY);
  const identity = await readJson<LockIdentity>(IDENTITY_KEY);
  return {
    configured: lock != null,
    biometric: lock?.biometric ?? false,
    identity,
  };
}

/** Keep the display identity current whenever we have a live session. */
export async function recordIdentity(identity: LockIdentity): Promise<void> {
  await writeJson(IDENTITY_KEY, identity);
}

/**
 * Create (or replace) the lock. Called only while the caller holds a real
 * session, so `identity` is authoritative. Resets the attempt counter.
 */
export async function setupLock(args: {
  pin: string;
  biometric: boolean;
  identity: LockIdentity;
}): Promise<void> {
  const salt = randomSalt();
  const hash = await hashPin(args.pin, salt);
  const lock: StoredLock = {
    salt,
    hash,
    biometric: args.biometric,
    createdAt: Date.now(),
  };
  await writeJson(PIN_KEY, lock);
  await writeJson(IDENTITY_KEY, args.identity);
  await SecureStore.deleteItemAsync(ATTEMPTS_KEY);
}

/** Flip biometric on/off without re-entering the PIN (called from settings). */
export async function setBiometricEnabled(on: boolean): Promise<void> {
  const lock = await readJson<StoredLock>(PIN_KEY);
  if (!lock) return;
  await writeJson(PIN_KEY, { ...lock, biometric: on });
}

/** Remove the lock entirely (disable in settings, or on sign-out). */
export async function clearLock(): Promise<void> {
  await SecureStore.deleteItemAsync(PIN_KEY);
  await SecureStore.deleteItemAsync(IDENTITY_KEY);
  await SecureStore.deleteItemAsync(ATTEMPTS_KEY);
}

/** Current cooldown, so the UnlockScreen can render a countdown on mount. */
export async function currentLockout(now: number = Date.now()): Promise<number | null> {
  const state = await readAttempts();
  return isLockedOut(state, now) ? state.lockUntil : null;
}

/**
 * Verify a PIN entry, updating the persisted attempt counter. `must_reauth`
 * means the caller should sign the user out and require an online password
 * sign-in (the lock has been exhausted).
 */
export async function verifyPin(
  pin: string,
  now: number = Date.now(),
): Promise<VerifyOutcome> {
  const lock = await readJson<StoredLock>(PIN_KEY);
  if (!lock) return { kind: "ok" }; // no lock configured → nothing to gate

  const state = await readAttempts();
  const candidate = await hashPin(pin, lock.salt);
  const matched = candidate === lock.hash;

  const { next, outcome } = applyAttempt(state, matched, now);
  await writeJson(ATTEMPTS_KEY, next);
  return outcome;
}
