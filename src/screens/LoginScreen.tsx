import { useEffect, useMemo, useState } from "react";
import {
  ActivityIndicator,
  KeyboardAvoidingView,
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
import { closePasswordSignIn, notePasswordSignIn } from "../mfa-session";
import { supabase } from "../supabase";
import { lightColors, type Palette } from "../theme";

const OFFLINE_MSG =
  "You're offline. Connect to the internet to sign in. If you've signed in on this phone before, close and reopen the app to unlock it offline.";

export function LoginScreen() {
  // The login screen (logged out = off the clock) is always the light theme.
  const c = lightColors;
  const styles = useMemo(() => makeStyles(c), [c]);
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [offline, setOffline] = useState(false);

  // A first-time sign-in genuinely can't work offline: the password is verified
  // on the server. Detect connectivity so we can say that plainly instead of
  // surfacing a raw "Network request failed".
  useEffect(() => {
    const unsub = NetInfo.addEventListener((state) => {
      setOffline(state.isConnected === false);
    });
    return () => unsub();
  }, []);

  async function onSignIn() {
    haptics.light();
    setError(null);
    if (offline) {
      setError(OFFLINE_MSG);
      haptics.warning();
      return;
    }
    setBusy(true);
    // Tells App this session comes from a password typed here, so it asks
    // the auth server about 2FA before any app screen shows (lib/mfa.ts
    // planCodeStep). Set first: the session reaches App before this resolves.
    notePasswordSignIn();
    const { error: err } = await supabase.auth.signInWithPassword({
      email: email.trim(),
      password,
    });
    // On success, App's onAuthStateChange swaps to the Clock screen.
    if (err) {
      closePasswordSignIn();
      // A dropped connection mid-request surfaces as a fetch failure; show the
      // same plain-language offline note rather than the raw library string.
      const isNetwork = /network request failed|fetch/i.test(err.message);
      setError(isNetwork ? OFFLINE_MSG : err.message);
      haptics.error();
    }
    setBusy(false);
  }

  const canSubmit = email.trim().length > 0 && password.length > 0 && !busy;

  return (
    <KeyboardAvoidingView
      style={styles.container}
      behavior={Platform.OS === "ios" ? "padding" : undefined}
    >
      <View style={styles.inner}>
        {offline ? (
          <View style={styles.offlineBanner}>
            <Text style={styles.offlineText}>No internet connection</Text>
          </View>
        ) : null}
        <View style={styles.brand}>
          <Wordmark palette={c} size={48} />
        </View>
        <Text style={styles.subtitle}>Clock in for your shift</Text>

        <TextInput
          style={styles.input}
          placeholder="Email"
          placeholderTextColor={c.textMuted}
          autoCapitalize="none"
          autoCorrect={false}
          keyboardType="email-address"
          textContentType="emailAddress"
          value={email}
          onChangeText={setEmail}
          editable={!busy}
        />
        <TextInput
          style={styles.input}
          placeholder="Password"
          placeholderTextColor={c.textMuted}
          secureTextEntry
          textContentType="password"
          value={password}
          onChangeText={setPassword}
          editable={!busy}
        />

        {error ? <Text style={styles.error}>{error}</Text> : null}

        <TouchableOpacity
          style={[styles.button, !canSubmit && styles.buttonDisabled]}
          onPress={onSignIn}
          disabled={!canSubmit}
          activeOpacity={0.85}
        >
          {busy ? (
            <ActivityIndicator color={c.accentText} />
          ) : (
            <Text style={styles.buttonText}>Sign in</Text>
          )}
        </TouchableOpacity>

        <Text style={styles.hint}>
          Use the same email and password as the Clox website.
        </Text>
        <Text style={styles.hint}>
          First time here or forgot your password? Set or reset it on the Clox
          website, then sign in with that email and password.
        </Text>
      </View>
    </KeyboardAvoidingView>
  );
}

const makeStyles = (c: Palette) =>
  StyleSheet.create({
    container: { flex: 1, backgroundColor: c.bg },
    inner: { flex: 1, justifyContent: "center", paddingHorizontal: 28 },
    brand: { alignItems: "center" },
    subtitle: {
      color: c.textMuted,
      fontSize: 16,
      textAlign: "center",
      marginTop: 6,
      marginBottom: 36,
    },
    input: {
      backgroundColor: c.surface,
      borderColor: c.border,
      borderWidth: 1,
      borderRadius: 14,
      paddingHorizontal: 16,
      paddingVertical: 16,
      color: c.text,
      fontSize: 17,
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
    offlineBanner: {
      backgroundColor: c.warn,
      borderRadius: 12,
      paddingVertical: 10,
      paddingHorizontal: 16,
      marginBottom: 24,
      alignSelf: "center",
    },
    // Light text on the amber: 5.17:1 (ink on it measured 3.50:1).
    offlineText: { color: c.accentText, fontSize: 14, fontWeight: "600" },
    hint: {
      color: c.textMuted,
      fontSize: 13,
      textAlign: "center",
      marginTop: 20,
    },
  });
