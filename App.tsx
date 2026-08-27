import { useEffect, useRef, useState } from "react";
import {
  ActivityIndicator,
  AppState,
  InteractionManager,
  StyleSheet,
  View,
} from "react-native";
import { StatusBar } from "expo-status-bar";
import { SafeAreaProvider } from "react-native-safe-area-context";

import type { Session } from "@supabase/supabase-js";

import { getStatus } from "./src/api";
import {
  clearBootSnapshot,
  readBootSnapshot,
  writeBootSnapshot,
} from "./src/boot-snapshot";
import {
  clearLock,
  getLockStatus,
  recordIdentity,
  type LockStatus,
} from "./src/lib/app-lock";
import { ErrorBoundary } from "./src/components/ErrorBoundary";
import { installErrorReporting } from "./src/error-reporting";
import { ManagerTabs } from "./src/navigation/ManagerTabs";
import { registerForPush, unregisterForPush } from "./src/push";
import { clearQueue, drainQueue, getQueueOwner, queuedCount } from "./src/queue";
import { ClockScreen } from "./src/screens/ClockScreen";
import { LoginScreen } from "./src/screens/LoginScreen";
import { UnlockScreen } from "./src/screens/UnlockScreen";
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
  // Offline app lock. `lockStatus` is read once on boot; `locked` starts true
  // whenever a lock is configured and a session is being restored (a cold start
  // always challenges), and flips false on a successful unlock. `bgSinceRef`
  // powers the re-lock grace period on foreground.
  const [lockStatus, setLockStatus] = useState<LockStatus | null>(null);
  const [locked, setLocked] = useState(false);
  const bgSinceRef = useRef<number | null>(null);

  useEffect(() => {
    void (async () => {
      const [{ data }, status] = await Promise.all([
        supabase.auth.getSession(),
        getLockStatus(),
      ]);
      setLockStatus(status);
      // A cold start always challenges when a lock exists and a session is
      // being restored — the unlock gate sits in front of the app.
      if (status.configured && data.session) setLocked(true);
      setSession(data.session);
      setLoading(false);
    })();
    const { data: sub } = supabase.auth.onAuthStateChange((_event, next) => {
      setSession(next);
    });
    return () => sub.subscription.unsubscribe();
  }, []);

  // Re-lock when the app returns to the foreground after a grace period, so a
  // quick app-switch doesn't nag but a phone left down re-challenges. Cold
  // start is already covered above. Only arms while a lock is configured.
  const LOCK_GRACE_MS = 60_000;
  useEffect(() => {
    const sub = AppState.addEventListener("change", (state) => {
      if (state === "active") {
        const since = bgSinceRef.current;
        bgSinceRef.current = null;
        // Re-read status on foreground (not on every tick) so a lock set up
        // mid-session arms without a restart, and a removed one stops locking.
        if (since != null && Date.now() - since > LOCK_GRACE_MS) {
          void getLockStatus().then((st) => {
            setLockStatus(st);
            if (st.configured) setLocked(true);
          });
        }
      } else if (state === "background" || state === "inactive") {
        if (bgSinceRef.current == null) bgSinceRef.current = Date.now();
      }
    });
    return () => sub.remove();
  }, []);

  // Guard the device-global punch queue across accounts: if the signed-in user
  // is not the one who enqueued the pending punches, clear them so they can't
  // drain under the wrong token. The common path (same user unlocking or
  // re-authenticating) matches and keeps the queue intact.
  useEffect(() => {
    const uid = session?.user?.id;
    if (!uid) return;
    void (async () => {
      const owner = await getQueueOwner();
      if (owner && owner !== uid && (await queuedCount()) > 0) {
        await clearQueue();
      }
    })();
  }, [session?.user?.id]);

  // Register this device for push once signed in. Deferred behind
  // InteractionManager so it never competes with the first render. No-op in
  // Expo Go / without an EAS dev build (see src/push.ts).
  useEffect(() => {
    if (!session) return;
    const task = InteractionManager.runAfterInteractions(() => {
      void getAccessToken().then((t) => {
        if (t) void registerForPush(t);
      });
    });
    return () => task.cancel();
  }, [session]);

  // Resolve the user's role. One SEQUENTIAL effect (not two racing ones): seed
  // the shell from the last-good snapshot first — same user only, so the cold
  // start paints ClockScreen vs ManagerTabs from local disk without waiting on
  // the network — then reconcile with the authoritative getStatus. A failed/
  // offline status keeps the seeded role (an offline manager is never demoted
  // to the employee shell), falling back to "employee" only when nothing was
  // seeded. Sequencing the two writers removes the race where the offline
  // fallback could beat the snapshot seed.
  useEffect(() => {
    if (!session) {
      setRole(null);
      return;
    }
    let cancelled = false;
    void (async () => {
      const snap = await readBootSnapshot();
      if (cancelled) return;
      const seeded =
        snap && snap.userId === session.user.id ? snap.role : null;
      if (seeded) setRole((cur) => cur ?? seeded);

      const t = await getAccessToken();
      if (cancelled) return;
      if (!t) {
        setRole((cur) => cur ?? seeded ?? "employee");
        return;
      }
      try {
        const res = await getStatus(t);
        if (cancelled) return;
        if (res.ok) {
          setRole(res.data.user.role);
          setTutorialDone(res.data.tutorialCompleted);
          void writeBootSnapshot({
            userId: session.user.id,
            role: res.data.user.role,
          });
          // Keep the lock's display identity current so the unlock screen names
          // the right person even after the access token later expires offline.
          void recordIdentity({
            userId: session.user.id,
            email: session.user.email ?? null,
            displayName: res.data.user.name,
            role: res.data.user.role,
          });
        } else {
          setRole((cur) => cur ?? seeded ?? "employee");
        }
      } catch {
        if (!cancelled) setRole((cur) => cur ?? seeded ?? "employee");
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [session]);

  const handleSignOut = async () => {
    const t = await getAccessToken();
    if (t) {
      await unregisterForPush(t);
      // Flush queued punches under THIS user first so they're attributed
      // correctly, then clear whatever couldn't send. The queue is device-
      // global and drains under whoever signs in next, so anything left would
      // otherwise record this user's punches as the next user's.
      try {
        await drainQueue(t);
      } catch {
        // Offline or a failed send — the clear below drops the remainder
        // rather than leaving it to mis-attribute.
      }
    }
    await clearQueue();
    await clearBootSnapshot();
    // The lock is bound to this account; the next person to sign in must set
    // their own. clearing also resets the failed-attempt counter.
    await clearLock();
    setLockStatus({ configured: false, biometric: false, identity: null });
    setLocked(false);
    await supabase.auth.signOut();
  };

  // Escape hatch from the lock screen: the user forgot their PIN, exhausted the
  // attempts, or chose to re-authenticate. Unlike an explicit Sign out, this
  // PRESERVES the punch queue: they are almost always the same person (it's
  // their phone) and will re-authenticate as themselves, so their offline
  // punches must survive. The owner stamp guards the rare case — if a DIFFERENT
  // user signs in, the sign-in reconcile effect below clears the queue before
  // it could drain under the wrong token. We still drop the lock (a forgotten
  // PIN can't gate anything) and the role snapshot.
  const handleReauth = () => {
    void (async () => {
      const t = await getAccessToken();
      if (t) await unregisterForPush(t);
      await clearBootSnapshot();
      await clearLock();
      setLockStatus({ configured: false, biometric: false, identity: null });
      setLocked(false);
      await supabase.auth.signOut();
    })();
  };

  const onUnlocked = () => setLocked(false);

  // Signed in but role not resolved yet — hold on the spinner so we don't flash
  // the employee screen before swapping to the manager tabs.
  const resolvingRole = session !== null && role === null;

  return (
    <SafeAreaProvider>
      <ErrorBoundary>
        <View style={styles.root}>
          <StatusBar style="dark" />
        {loading ? (
          <View style={styles.center}>
            <ActivityIndicator color={lightColors.accent} size="large" />
          </View>
        ) : !session ? (
          <LoginScreen />
        ) : lockStatus?.configured && locked ? (
          <UnlockScreen
            identity={lockStatus.identity}
            biometricEnabled={lockStatus.biometric}
            onUnlocked={onUnlocked}
            onReauth={handleReauth}
          />
        ) : resolvingRole ? (
          <View style={styles.center}>
            <ActivityIndicator color={lightColors.accent} size="large" />
          </View>
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
      </ErrorBoundary>
    </SafeAreaProvider>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: lightColors.bg },
  center: { flex: 1, alignItems: "center", justifyContent: "center" },
});
