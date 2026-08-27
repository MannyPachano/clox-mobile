import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  ActivityIndicator,
  AppState,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from "react-native";

import { Wordmark } from "../components/Wordmark";
import { PinPad } from "../components/PinPad";
import {
  authenticateBiometric,
  biometricLabel,
  isBiometricAvailable,
  type BiometricKind,
} from "../lib/biometrics";
import { haptics } from "../lib/haptics";
import {
  currentLockout,
  PIN_LENGTH,
  verifyPin,
  type LockIdentity,
} from "../lib/app-lock";
import { lightColors, type Palette } from "../theme";

/**
 * The offline lock screen. Shown on cold start (and after a re-lock) whenever a
 * lock is configured, BEFORE any app data is revealed. Unlocking is entirely
 * local: a biometric check or the Clox PIN, no network. On too many misses it
 * calls onReauth so the app signs out and requires an online password sign-in.
 */
export function UnlockScreen({
  identity,
  biometricEnabled,
  onUnlocked,
  onReauth,
}: {
  identity: LockIdentity | null;
  biometricEnabled: boolean;
  onUnlocked: () => void;
  onReauth: () => void;
}) {
  const c = lightColors; // locked = off the clock = always light
  const styles = useMemo(() => makeStyles(c), [c]);

  const [pin, setPin] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [checking, setChecking] = useState(false);
  const [bioKind, setBioKind] = useState<BiometricKind>("none");
  const [bioReady, setBioReady] = useState(false);
  // Epoch ms the current cooldown ends, or null. Drives the countdown label.
  const [retryAt, setRetryAt] = useState<number | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const biometricTriedRef = useRef(false);

  const lockedOut = retryAt != null && now < retryAt;

  // Restore any in-force cooldown from disk (survives an app kill mid-lockout).
  useEffect(() => {
    void currentLockout().then((until) => {
      if (until) setRetryAt(until);
    });
  }, []);

  // Tick once a second only while a cooldown is counting down.
  useEffect(() => {
    if (!lockedOut) return;
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, [lockedOut]);

  const runBiometric = useCallback(async () => {
    setError(null);
    const ok = await authenticateBiometric("Unlock Clox to clock in");
    if (ok) {
      haptics.success();
      onUnlocked();
    }
  }, [onUnlocked]);

  // Offer biometrics on mount (once), and again when the app returns to the
  // foreground on the lock screen — but never while a cooldown is active.
  useEffect(() => {
    let cancelled = false;
    void isBiometricAvailable().then((b) => {
      if (cancelled) return;
      setBioKind(b.kind);
      setBioReady(b.available);
      if (
        b.available &&
        biometricEnabled &&
        !biometricTriedRef.current &&
        !lockedOut
      ) {
        biometricTriedRef.current = true;
        void runBiometric();
      }
    });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    const sub = AppState.addEventListener("change", (s) => {
      if (s === "active" && bioReady && biometricEnabled && !lockedOut) {
        void runBiometric();
      }
    });
    return () => sub.remove();
  }, [bioReady, biometricEnabled, lockedOut, runBiometric]);

  const submit = useCallback(
    async (entered: string) => {
      setChecking(true);
      const outcome = await verifyPin(entered);
      setChecking(false);
      setPin("");
      switch (outcome.kind) {
        case "ok":
          haptics.success();
          onUnlocked();
          return;
        case "wrong":
          haptics.error();
          setError(
            `Wrong PIN. ${outcome.failsLeft} ${
              outcome.failsLeft === 1 ? "try" : "tries"
            } left before you'll need to sign in again.`,
          );
          return;
        case "locked_out":
          haptics.error();
          setRetryAt(outcome.retryAt);
          setNow(Date.now());
          setError(null);
          return;
        case "must_reauth":
          haptics.error();
          onReauth();
          return;
      }
    },
    [onUnlocked, onReauth],
  );

  // Auto-submit the moment the pad fills.
  useEffect(() => {
    if (pin.length === PIN_LENGTH && !checking && !lockedOut) {
      void submit(pin);
    }
  }, [pin, checking, lockedOut, submit]);

  const who =
    identity?.displayName?.trim() ||
    identity?.email?.trim() ||
    "your account";
  const secsLeft = lockedOut ? Math.ceil((retryAt! - now) / 1000) : 0;

  return (
    <View style={styles.container}>
      <View style={styles.inner}>
        <View style={styles.brand}>
          <Wordmark palette={c} size={44} />
        </View>
        <Text style={styles.subtitle}>Unlock to clock in</Text>
        <Text style={styles.who} numberOfLines={1}>
          {who}
        </Text>

        {lockedOut ? (
          <View style={styles.lockoutBox}>
            <Text style={styles.lockoutTitle}>Too many tries</Text>
            <Text style={styles.lockoutBody}>
              Try again in {secsLeft}s, or sign in with your password.
            </Text>
          </View>
        ) : (
          <PinPad
            value={pin}
            onChange={(next) => {
              if (error) setError(null);
              setPin(next);
            }}
            length={PIN_LENGTH}
            palette={c}
            disabled={checking}
          />
        )}

        <View style={styles.status}>
          {checking ? (
            <ActivityIndicator color={c.accent} />
          ) : error ? (
            <Text style={styles.error}>{error}</Text>
          ) : null}
        </View>

        <View style={styles.actions}>
          {bioReady && biometricEnabled && !lockedOut ? (
            <TouchableOpacity onPress={runBiometric} activeOpacity={0.7}>
              <Text style={styles.link}>Use {biometricLabel(bioKind)}</Text>
            </TouchableOpacity>
          ) : null}
          <TouchableOpacity onPress={onReauth} activeOpacity={0.7}>
            <Text style={styles.linkMuted}>Sign in with password instead</Text>
          </TouchableOpacity>
        </View>
      </View>
    </View>
  );
}

const makeStyles = (c: Palette) =>
  StyleSheet.create({
    container: { flex: 1, backgroundColor: c.bg },
    inner: {
      flex: 1,
      justifyContent: "center",
      alignItems: "center",
      paddingHorizontal: 28,
    },
    brand: { alignItems: "center" },
    subtitle: {
      color: c.textMuted,
      fontSize: 16,
      textAlign: "center",
      marginTop: 6,
    },
    who: {
      color: c.text,
      fontSize: 17,
      fontWeight: "600",
      textAlign: "center",
      marginTop: 2,
      marginBottom: 34,
      maxWidth: 300,
    },
    status: { height: 40, justifyContent: "center", marginTop: 18 },
    error: {
      color: c.danger,
      fontSize: 14,
      textAlign: "center",
      maxWidth: 320,
    },
    actions: { alignItems: "center", gap: 18, marginTop: 8 },
    link: { color: c.accent, fontSize: 16, fontWeight: "600" },
    linkMuted: { color: c.textMuted, fontSize: 14 },
    lockoutBox: {
      alignItems: "center",
      paddingVertical: 40,
      paddingHorizontal: 20,
    },
    lockoutTitle: { color: c.text, fontSize: 20, fontWeight: "700" },
    lockoutBody: {
      color: c.textMuted,
      fontSize: 15,
      textAlign: "center",
      marginTop: 8,
      maxWidth: 280,
    },
  });
