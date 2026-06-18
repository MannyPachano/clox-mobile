import { useEffect, useState } from "react";
import { ActivityIndicator, StyleSheet, View } from "react-native";
import { StatusBar } from "expo-status-bar";
import { SafeAreaProvider } from "react-native-safe-area-context";

import type { Session } from "@supabase/supabase-js";

import { getStatus } from "./src/api";
import { installErrorReporting } from "./src/error-reporting";
import { ManagerTabs } from "./src/navigation/ManagerTabs";
import { registerForPush, unregisterForPush } from "./src/push";
import { ClockScreen } from "./src/screens/ClockScreen";
import { LoginScreen } from "./src/screens/LoginScreen";
import { getAccessToken, supabase } from "./src/supabase";
import { lightColors } from "./src/theme";
import { TutorialProvider } from "./src/tutorial/TutorialContext";

// Install the global JS-error handler as early as possible, before the first
// render, so even boot-time crashes are reported.
installErrorReporting();

/**
 * App root. No navigation library needed for a two-screen app: we render the
 * Login screen or the Clock screen purely off the Supabase auth state, which
 * `onAuthStateChange` keeps live (sign-in/out flips the screen automatically).
 *
 * The shell is light (logged out / clocked out); the Clock screen flips itself
 * to the dark on-shift palette + a light status bar when the timer is running.
 */
export default function App() {
  const [session, setSession] = useState<Session | null>(null);
  const [loading, setLoading] = useState(true);
  const [role, setRole] = useState<string | null>(null);
  // Default true → never auto-run the tour until the server confirms it's unseen
  // (so an offline/failed status fetch doesn't surprise an existing user).
  const [tutorialDone, setTutorialDone] = useState(true);

  useEffect(() => {
    supabase.auth.getSession().then(({ data }) => {
      setSession(data.session);
      setLoading(false);
    });
    const { data: sub } = supabase.auth.onAuthStateChange((_event, next) => {
      setSession(next);
    });
    return () => sub.subscription.unsubscribe();
  }, []);

  // Register this device for push once signed in. No-op in Expo Go / without an
  // EAS dev build (see src/push.ts), so it never affects the current setup.
  useEffect(() => {
    if (!session) return;
    void getAccessToken().then((t) => {
      if (t) void registerForPush(t);
    });
  }, [session]);

  // Resolve the user's role (manager vs employee) to pick the right shell.
  // Defaults to "employee" if it can't be fetched (e.g. offline).
  useEffect(() => {
    if (!session) {
      setRole(null);
      return;
    }
    let cancelled = false;
    void getAccessToken().then(async (t) => {
      if (!t) {
        if (!cancelled) setRole("employee");
        return;
      }
      try {
        const res = await getStatus(t);
        if (!cancelled) {
          setRole(res.ok ? res.data.user.role : "employee");
          if (res.ok) setTutorialDone(res.data.tutorialCompleted);
        }
      } catch {
        if (!cancelled) setRole("employee");
      }
    });
    return () => {
      cancelled = true;
    };
  }, [session]);

  const handleSignOut = async () => {
    const t = await getAccessToken();
    if (t) await unregisterForPush(t);
    await supabase.auth.signOut();
  };

  // Signed in but role not resolved yet — hold on the spinner so we don't flash
  // the employee screen before swapping to the manager tabs.
  const resolvingRole = session !== null && role === null;

  return (
    <SafeAreaProvider>
      <View style={styles.root}>
        <StatusBar style="dark" />
        {loading || resolvingRole ? (
          <View style={styles.center}>
            <ActivityIndicator color={lightColors.accent} size="large" />
          </View>
        ) : !session ? (
          <LoginScreen />
        ) : role === "manager" ? (
          <TutorialProvider role="manager" autoStart={!tutorialDone}>
            <ManagerTabs session={session} onSignOut={handleSignOut} />
          </TutorialProvider>
        ) : (
          <TutorialProvider role="employee" autoStart={!tutorialDone}>
            <ClockScreen session={session} onSignOut={handleSignOut} />
          </TutorialProvider>
        )}
      </View>
    </SafeAreaProvider>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: lightColors.bg },
  center: { flex: 1, alignItems: "center", justifyContent: "center" },
});
