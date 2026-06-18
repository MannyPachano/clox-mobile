import * as Crypto from "expo-crypto";

/**
 * A v4 UUID, used as the idempotency key for each punch. The server accepts
 * only well-formed UUIDs (junk is ignored), and a stable key per punch is what
 * makes offline replay safe — re-sending the same punch never double-counts.
 */
export function newUuid(): string {
  return Crypto.randomUUID();
}
