/**
 * Device attestation for a punch (iOS App Attest / Android Play Integrity).
 *
 * TEMPORARILY DISABLED for the 1.0 launch.
 *
 * The @expo/app-integrity native module we used is published only for SDK 57
 * (expo@57.0.0-preview), while this app is on SDK 54. Its `AppIntegrity`
 * wrapper reads a native constant (`isSupported`) EAGERLY at import time, so the
 * ABI-mismatched native module crashed the whole JS bundle on boot (a silent
 * white screen, before the error handler installs and outside the
 * ErrorBoundary). The package has been removed so it can't be autolinked.
 *
 * Attestation is a best-effort MONITOR signal: the server treats it as optional
 * and never blocks a clock-in on it, so shipping without it changes nothing for
 * users. The server endpoints (/api/mobile/v1/attest/challenge and /register)
 * still exist and simply receive no iOS assertions until this is restored.
 *
 * To restore post-launch: reinstall an SDK-aligned @expo/app-integrity (or do it
 * after upgrading to SDK 57), then bring back the real implementation from git
 * (commit c62971e — "Build 11: App Attest, geofence anti-spoof ...").
 */

export type PunchAttestation = {
  integrityToken?: string; // Android Play Integrity
  appAttestKeyId?: string; // iOS App Attest
  appAttestAssertion?: string;
};

/**
 * No-op for the 1.0 launch: always returns {} so the clock-in payload spreads
 * no attestation fields. Signature is unchanged so callers (src/api.ts) are
 * untouched.
 */
export async function getAttestationForPunch(
  _idempotencyKey: string,
  _authToken: string,
): Promise<PunchAttestation> {
  return {};
}
