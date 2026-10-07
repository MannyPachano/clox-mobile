import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  ActivityIndicator,
  KeyboardAvoidingView,
  Linking,
  Platform,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from "react-native";

import NetInfo from "@react-native-community/netinfo";

import { Wordmark } from "../components/Wordmark";
import { haptics } from "../lib/haptics";
import { isSixDigitCode, MFA_COPY, tokenAal } from "../lib/mfa";
import { findVerifiedTotp, verifyTotpCode } from "../mfa-session";
import { getAccessToken } from "../supabase";
import { lightColors, type Palette } from "../theme";

type Load =
  | { kind: "loading" }
  | { kind: "ready"; factorId: string }
  /** Nothing to enter yet: offline, the sign-in ended, or the factors could
   *  not be read. `message` says which. */
  | { kind: "blocked"; message: string; canRetry: boolean };

/**
 * The second step of signing in, for an account with 2FA turned on. App shows
 * it after a password sign-in on this phone, at launch when the app closed on
 * it, and whenever the server answers mfa_required (lib/mfa.ts planCodeStep).
 * It covers the app's screens until the code is in, without unmounting them,
 * and never signs anyone out by itself: punches made meanwhile stay in the
 * queue, and App sends them once the code is accepted (`sending` is true
 * while it does).
 *
 * Recovery codes stay on the web: using one removes 2FA from the account,
 * which signs this phone out, and the person then signs in with a password.
 */
export function MfaScreen({
  sending,
  onVerified,
  onNoFactor,
  onSignOut,
}: {
  sending: boolean;
  onVerified: () => void;
  /** The account has no verified factor any more (2FA turned off). */
  onNoFactor: () => void;
  onSignOut: () => void;
}) {
  // Off the clock until the code is in, so always the light theme.
  const c = lightColors;
  const styles = useMemo(() => makeStyles(c), [c]);
  const [load, setLoad] = useState<Load>({ kind: "loading" });
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const loadingRef = useRef(false);
  const verifiedRef = useRef(false);
  const inputRef = useRef<TextInput>(null);
  // App passes new callbacks on every render; read them through refs so the
  // factor is loaded once, not again at each App render.
  const onVerifiedRef = useRef(onVerified);
  const onNoFactorRef = useRef(onNoFactor);
  useEffect(() => {
    onVerifiedRef.current = onVerified;
    onNoFactorRef.current = onNoFactor;
  }, [onVerified, onNoFactor]);

  const loadFactor = useCallback(async () => {
    if (loadingRef.current) return;
    loadingRef.current = true;
    setLoad({ kind: "loading" });
    try {
      // Already past the second step (the code went in just before this
      // screen came back up): nothing to ask.
      if (tokenAal(await getAccessToken()) === "aal2") {
        if (!verifiedRef.current) {
          verifiedRef.current = true;
          onVerifiedRef.current();
        }
        return;
      }
      const found = await findVerifiedTotp();
      if (found.kind === "found") {
        setLoad({ kind: "ready", factorId: found.factorId });
      } else if (found.kind === "none") {
        onNoFactorRef.current();
      } else if (found.error === "session_ended") {
        setLoad({
          kind: "blocked",
          message: MFA_COPY.errors.session_ended,
          canRetry: false,
        });
      } else {
        setLoad({
          kind: "blocked",
          message:
            found.error === "offline"
              ? MFA_COPY.errors.offline
              : MFA_COPY.loadFailed,
          canRetry: true,
        });
      }
    } finally {
      loadingRef.current = false;
    }
  }, []);

  useEffect(() => {
    void loadFactor();
  }, [loadFactor]);

  // The field can't take focus while the factor loads, so focus it once
  // the code can be entered.
  useEffect(() => {
    if (load.kind === "ready") inputRef.current?.focus();
  }, [load.kind]);

  // Offline when the step came up: try again by itself once the phone is
  // back online.
  const loadRef = useRef(load);
  useEffect(() => {
    loadRef.current = load;
  }, [load]);
  useEffect(() => {
    const unsub = NetInfo.addEventListener((state) => {
      const cur = loadRef.current;
      if (state.isConnected && cur.kind === "blocked" && cur.canRetry) {
        void loadFactor();
      }
    });
    return () => unsub();
  }, [loadFactor]);

  const submit = useCallback(
    async (value: string) => {
      if (load.kind !== "ready" || busy || verifiedRef.current) return;
      setError(null);
      if (!isSixDigitCode(value)) {
        setError(MFA_COPY.notSix);
        haptics.warning();
        return;
      }
      setBusy(true);
      const res = await verifyTotpCode(load.factorId, value);
      setBusy(false);
      if (res.ok) {
        haptics.success();
        verifiedRef.current = true;
        onVerifiedRef.current();
        return;
      }
      haptics.error();
      setError(MFA_COPY.errors[res.error]);
      if (res.error === "wrong_code") setCode("");
    },
    [load, busy],
  );

  const onChangeCode = (text: string) => {
    const digits = text.replace(/\D/g, "").slice(0, 6);
    setCode(digits);
    if (error) setError(null);
    // The sixth digit sends it, as most code screens on a phone do.
    if (digits.length === 6 && code.length < 6) void submit(digits);
  };

  const ready = load.kind === "ready";
  const canSubmit = ready && code.length === 6 && !busy && !sending;

  return (
    <KeyboardAvoidingView
      style={styles.container}
      behavior={Platform.OS === "ios" ? "padding" : undefined}
    >
      <View style={styles.inner}>
        <View style={styles.brand}>
          <Wordmark palette={c} size={40} />
        </View>
        <Text style={styles.eyebrow}>{MFA_COPY.eyebrow.toUpperCase()}</Text>
        <Text style={styles.title} accessibilityRole="header">
          {MFA_COPY.title}
        </Text>

        {sending ? (
          <View style={styles.sending}>
            <ActivityIndicator color={c.accent} />
            <Text style={styles.body}>{MFA_COPY.sending}</Text>
          </View>
        ) : (
          <>
            <Text style={styles.body}>{MFA_COPY.body}</Text>

            {load.kind === "blocked" ? (
              <>
                <Text style={styles.error} accessibilityLiveRegion="polite">
                  {load.message}
                </Text>
                {load.canRetry ? (
                  <TouchableOpacity
                    style={styles.button}
                    onPress={() => void loadFactor()}
                    activeOpacity={0.85}
                  >
                    <Text style={styles.buttonText}>{MFA_COPY.tryAgain}</Text>
                  </TouchableOpacity>
                ) : null}
              </>
            ) : (
              <>
                <TextInput
                  ref={inputRef}
                  style={styles.input}
                  value={code}
                  onChangeText={onChangeCode}
                  placeholder={MFA_COPY.placeholder}
                  placeholderTextColor={c.textMuted}
                  keyboardType="number-pad"
                  inputMode="numeric"
                  textContentType="oneTimeCode"
                  autoComplete="one-time-code"
                  maxLength={6}
                  editable={ready && !busy}
                  accessibilityLabel="Authentication code"
                  onSubmitEditing={() => void submit(code)}
                />

                {error ? (
                  <Text style={styles.error} accessibilityLiveRegion="polite">
                    {error}
                  </Text>
                ) : null}

                <TouchableOpacity
                  style={[styles.button, !canSubmit && styles.buttonDisabled]}
                  onPress={() => void submit(code)}
                  disabled={!canSubmit}
                  activeOpacity={0.85}
                >
                  {busy || load.kind === "loading" ? (
                    <ActivityIndicator color={c.accentText} />
                  ) : (
                    <Text style={styles.buttonText}>{MFA_COPY.verify}</Text>
                  )}
                </TouchableOpacity>
              </>
            )}

            <TouchableOpacity
              onPress={() => void Linking.openURL(MFA_COPY.recoveryUrl)}
              accessibilityRole="link"
              hitSlop={{ top: 6, bottom: 6, left: 6, right: 6 }}
            >
              <Text style={styles.hint}>{MFA_COPY.recovery}</Text>
            </TouchableOpacity>

            <TouchableOpacity
              style={styles.signOut}
              onPress={onSignOut}
              disabled={busy}
              hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
            >
              <Text style={styles.signOutText}>{MFA_COPY.signOut}</Text>
            </TouchableOpacity>
          </>
        )}
      </View>
    </KeyboardAvoidingView>
  );
}

const makeStyles = (c: Palette) =>
  StyleSheet.create({
    container: { flex: 1, backgroundColor: c.bg },
    inner: { flex: 1, justifyContent: "center", paddingHorizontal: 28 },
    brand: { alignItems: "center", marginBottom: 28 },
    eyebrow: {
      color: c.textMuted,
      fontSize: 12,
      fontWeight: "600",
      letterSpacing: 1.6,
      textAlign: "center",
    },
    title: {
      color: c.text,
      fontSize: 26,
      fontWeight: "600",
      textAlign: "center",
      marginTop: 8,
    },
    body: {
      color: c.textMuted,
      fontSize: 16,
      textAlign: "center",
      marginTop: 10,
      marginBottom: 28,
    },
    sending: { alignItems: "center", marginTop: 24 },
    input: {
      backgroundColor: c.surface,
      borderColor: c.border,
      borderWidth: 1,
      borderRadius: 14,
      paddingHorizontal: 16,
      paddingVertical: 16,
      color: c.text,
      fontSize: 24,
      letterSpacing: 8,
      textAlign: "center",
      marginBottom: 14,
    },
    button: {
      backgroundColor: c.accent,
      borderRadius: 14,
      paddingVertical: 18,
      alignItems: "center",
      marginTop: 6,
    },
    buttonDisabled: { opacity: 0.5 },
    buttonText: { color: c.accentText, fontSize: 18, fontWeight: "700" },
    error: {
      color: c.danger,
      fontSize: 14,
      marginBottom: 12,
      textAlign: "center",
    },
    hint: {
      color: c.textMuted,
      fontSize: 13,
      textAlign: "center",
      marginTop: 24,
      textDecorationLine: "underline",
    },
    signOut: { alignSelf: "center", marginTop: 18, paddingVertical: 6 },
    signOutText: { color: c.textMuted, fontSize: 15, fontWeight: "600" },
  });
