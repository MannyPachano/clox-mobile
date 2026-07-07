import { useMemo, useState } from "react";
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

import { Wordmark } from "../components/Wordmark";
import { haptics } from "../lib/haptics";
import { supabase } from "../supabase";
import { lightColors, type Palette } from "../theme";

export function LoginScreen() {
  // The login screen (logged out = off the clock) is always the light theme.
  const c = lightColors;
  const styles = useMemo(() => makeStyles(c), [c]);
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function onSignIn() {
    haptics.light();
    setError(null);
    setBusy(true);
    const { error: err } = await supabase.auth.signInWithPassword({
      email: email.trim(),
      password,
    });
    // On success, App's onAuthStateChange swaps to the Clock screen.
    if (err) {
      setError(err.message);
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
    hint: {
      color: c.textMuted,
      fontSize: 13,
      textAlign: "center",
      marginTop: 20,
    },
  });
