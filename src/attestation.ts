import * as AppIntegrity from "@expo/app-integrity";
import * as Crypto from "expo-crypto";
import * as SecureStore from "expo-secure-store";
import { Platform } from "react-native";

import { API_BASE_URL } from "./config";

/** Clox Labs LLC Google Cloud project number (public, not a secret). */
const CLOUD_PROJECT_NUMBER = "751590085504";
const KEY_ID_STORE = "clox.appattest.keyId";

export type PunchAttestation = {
  integrityToken?: string; // Android Play Integrity
  appAttestKeyId?: string; // iOS App Attest
  appAttestAssertion?: string;
};

let androidPrepared = false;

/**
 * Best-effort device attestation for a punch, generated at SEND time (the app
 * is online when it drains the queue, so the Play Integrity token is fresh and
 * the tap stays fast). Binds to the punch's idempotency key: iOS signs it into
 * the assertion, Android sets requestHash = base64(SHA256(idempotencyKey)) —
 * both of which the server recomputes.
 *
 * Returns {} on any failure or unsupported device. Attestation is a monitor
 * signal the server flags for a manager, never a blocker, so failing quietly is
 * correct — a worker is never stopped from clocking in.
 */
export async function getAttestationForPunch(
  idempotencyKey: string,
  authToken: string,
): Promise<PunchAttestation> {
  try {
    if (Platform.OS === "ios") {
      return await iosAttestation(idempotencyKey, authToken);
    }
    if (Platform.OS === "android") {
      return await androidAttestation(idempotencyKey);
    }
    return {};
  } catch {
    return {};
  }
}

async function androidAttestation(
  idempotencyKey: string,
): Promise<PunchAttestation> {
  if (!androidPrepared) {
    await AppIntegrity.prepareIntegrityTokenProviderAsync(CLOUD_PROJECT_NUMBER);
    androidPrepared = true;
  }
  // Must match the server's playIntegrityRequestHash: base64(SHA256(key)).
  const requestHash = await Crypto.digestStringAsync(
    Crypto.CryptoDigestAlgorithm.SHA256,
    idempotencyKey,
    { encoding: Crypto.CryptoEncoding.BASE64 },
  );
  const token = await AppIntegrity.requestIntegrityCheckAsync(requestHash);
  return token ? { integrityToken: token } : {};
}

async function iosAttestation(
  idempotencyKey: string,
  authToken: string,
): Promise<PunchAttestation> {
  if (!AppIntegrity.isSupported) return {};
  const keyId = await ensureRegisteredKey(authToken);
  if (!keyId) return {};
  // The module hashes this string to the clientDataHash; the server verifies
  // with payload = idempotencyKey (which it also hashes), so they agree.
  const assertion = await AppIntegrity.generateAssertionAsync(
    keyId,
    idempotencyKey,
  );
  return assertion
    ? { appAttestKeyId: keyId, appAttestAssertion: assertion }
    : {};
}

/** Reuse a registered key, or register a new one once (needs network). */
async function ensureRegisteredKey(authToken: string): Promise<string | null> {
  const existing = await SecureStore.getItemAsync(KEY_ID_STORE);
  if (existing) return existing;

  const keyId = await AppIntegrity.generateKeyAsync();
  const challenge = await fetchChallenge(authToken);
  if (!challenge) return null;
  const attestation = await AppIntegrity.attestKeyAsync(keyId, challenge);
  const registered = await postRegister(authToken, {
    keyId,
    attestation,
    challenge,
  });
  if (!registered) return null;

  await SecureStore.setItemAsync(KEY_ID_STORE, keyId);
  return keyId;
}

async function fetchChallenge(authToken: string): Promise<string | null> {
  const res = await fetch(`${API_BASE_URL}/api/mobile/v1/attest/challenge`, {
    method: "POST",
    headers: { Authorization: `Bearer ${authToken}` },
  });
  if (!res.ok) return null;
  const json = (await res.json().catch(() => null)) as {
    challenge?: string;
  } | null;
  return json?.challenge ?? null;
}

async function postRegister(
  authToken: string,
  body: { keyId: string; attestation: string; challenge: string },
): Promise<boolean> {
  const res = await fetch(`${API_BASE_URL}/api/mobile/v1/attest/register`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${authToken}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) return false;
  const json = (await res.json().catch(() => null)) as { ok?: boolean } | null;
  return json?.ok === true;
}
