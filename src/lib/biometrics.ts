/**
 * Thin wrapper over expo-local-authentication for the app lock.
 *
 * Every entry point degrades gracefully: if the native module isn't present
 * (Expo Go, or a build made before it was added) or the device has no enrolled
 * biometrics, `isBiometricAvailable()` returns { available: false } and the lock
 * falls back to PIN only. Nothing here ever throws to the caller.
 */

import * as LocalAuthentication from "expo-local-authentication";

export type BiometricKind = "face" | "fingerprint" | "iris" | "none";

export type BiometricAvailability = {
  available: boolean;
  kind: BiometricKind;
};

/**
 * Whether this device can do a biometric check right now: hardware present AND
 * at least one biometric enrolled. Returns the strongest enrolled type so the
 * UI can label the button ("Use Face ID" vs "Use fingerprint").
 */
export async function isBiometricAvailable(): Promise<BiometricAvailability> {
  try {
    const hasHardware = await LocalAuthentication.hasHardwareAsync();
    if (!hasHardware) return { available: false, kind: "none" };
    const enrolled = await LocalAuthentication.isEnrolledAsync();
    if (!enrolled) return { available: false, kind: "none" };

    const types =
      await LocalAuthentication.supportedAuthenticationTypesAsync();
    const T = LocalAuthentication.AuthenticationType;
    let kind: BiometricKind = "fingerprint";
    if (types.includes(T.FACIAL_RECOGNITION)) kind = "face";
    else if (types.includes(T.FINGERPRINT)) kind = "fingerprint";
    else if (types.includes(T.IRIS)) kind = "iris";
    return { available: true, kind };
  } catch {
    return { available: false, kind: "none" };
  }
}

/** Human label for a biometric kind, for buttons and prompts. */
export function biometricLabel(kind: BiometricKind): string {
  switch (kind) {
    case "face":
      return "Face ID";
    case "fingerprint":
      return "fingerprint";
    case "iris":
      return "iris";
    default:
      return "biometrics";
  }
}

/**
 * Run a biometric check. Returns true only on a confirmed success. Any error,
 * cancel, or fallback resolves to false so the caller shows the PIN pad — the
 * biometric prompt is never the only way in.
 */
export async function authenticateBiometric(reason: string): Promise<boolean> {
  try {
    const res = await LocalAuthentication.authenticateAsync({
      promptMessage: reason,
      // We provide our own PIN pad, so don't offer the OS passcode fallback —
      // that would unlock with the device passcode, not the Clox PIN.
      disableDeviceFallback: true,
      cancelLabel: "Use PIN",
    });
    return res.success === true;
  } catch {
    return false;
  }
}
