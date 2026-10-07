import { useCallback, useEffect, useRef, useState } from "react";
import {
  ActivityIndicator,
  Alert,
  AppState,
  InteractionManager,
  StyleSheet,
  View,
} from "react-native";
import * as Notifications from "expo-notifications";
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
import {
  clearFenceCache,
  clearFenceCacheUnlessOwner,
} from "./src/fence-cache";
import { installErrorReporting, reportError } from "./src/error-reporting";
import { MFA_COPY, MFA_REQUIRED, onMfaRequired, tokenAal } from "./src/lib/mfa";
import {
  clearSecondFactorCache,
  secondFactorNeeded,
} from "./src/mfa-session";
import { ManagerTabs } from "./src/navigation/ManagerTabs";
import { registerForPush, unregisterForPush } from "./src/push";
import {
  cancelAllReminders,
  clearReminderPrefsCache,
} from "./src/reminder-notifications";
import { tapTargetFor } from "./src/reminders";
import {
  clearQueue,
  drainQueue,
  getQueueOwner,
  queuedCount,
  storedPunchCount,
} from "./src/queue";
import { ClockScreen } from "./src/screens/ClockScreen";
import { MfaScreen } from "./src/screens/MfaScreen";
import { LoginScreen } from "./src/screens/LoginScreen";
import { UnlockScreen } from "./src/screens/UnlockScreen";
import { getAccessToken, supabase } from "./src/supabase";
import { lightColors } from "./src/theme";
import { TutorialProvider } from "./src/tutorial/TutorialContext";

// Install the global JS-error handler as early as possible, before the first
// render, so even boot-time crashes are reported.
installErrorReporting();

/** A tapped notification waiting for the screen it opens. */
type Tapped = { data: unknown };

/** Back in the foreground after longer than this, a configured app lock
 *  challenges again. */
const LOCK_GRACE_MS = 60_000;
/** A tap the manager tabs took this recently is given to them again when
 *  the app lock comes back on (see the relock below). */
const TAP_REPLAY_MS = 10_000;
/** How long the code step waits for the saved punches to send before it
 *  hands over to the Clock screen, which keeps retrying on its own. */
const CODE_SEND_BUDGET_MS = 15_000;

/** The second step of signing in, for one user: "code" while it is asked
 *  for, "sending" while the punches saved meanwhile are sent. */
type CodeStep = { userId: string; phase: "code" | "sending" };

// Taps already taken, by notification. On a cold start the launching tap can
// arrive both as the last response and through the listener; it is acted on
// once. Module state, because App mounts once per JS runtime.
const seenTaps = new Set<string>();

function takeTap(res: Notifications.NotificationResponse | null): Tapped | null {
  if (!res) return null;
  // A tap on the notification itself, not an action button.
  if (res.actionIdentifier !== Notifications.DEFAULT_ACTION_IDENTIFIER) {
    return null;
  }
  const key = `${res.notification.request.identifier}|${res.notification.date}`;
  if (seenTaps.has(key)) return null;
  seenTaps.add(key);
  return { data: res.notification.request.content.data };
}

/** The tap that launched the app, if any. expo-notifications' copy of it is
 *  cleared as it is taken, so a later launch of this JS (an update reload)
 *  never acts on it again; from here on only App's state holds it. */
function coldStartTap(): Tapped | null {
  try {
    const t = takeTap(Notifications.getLastNotificationResponse());
    if (t) Notifications.clearLastNotificationResponse();
    return t;
  } catch (err) {
    reportError(err, "App.coldStartTap");
    return null;
  }
}

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
  // Offline app lock. `lockStatus` is read on boot, on the way to the
  // background and on a return after the grace period; `locked` starts true
  // whenever a lock is configured and a session is being restored (a cold start
  // always challenges), and flips false on a successful unlock. `bgSinceRef`
  // powers the re-lock grace period on foreground.
  const [lockStatus, setLockStatus] = useState<LockStatus | null>(null);
  const [locked, setLocked] = useState(false);
  const bgSinceRef = useRef<number | null>(null);
  // Notification taps are caught here because App is always mounted: on a
  // cold start, and while the app lock is up, the manager tabs are not. The
  // tap waits until the shell that can act on it is showing
  // (reminders.ts tapTargetFor): the refused clock-in push opens the Roster
  // tab for a manager, and a reminder opens the Clock tab.
  const [tapped, setTapped] = useState<Tapped | null>(coldStartTap);
  // Mirrors for the listeners below, which must decide at the moment an
  // event arrives: whether a lock is known to be set, and the tap the
  // manager tabs most recently took.
  const lockConfiguredRef = useRef(false);
  useEffect(() => {
    lockConfiguredRef.current = !!lockStatus?.configured;
  }, [lockStatus]);
  const tappedRef = useRef<Tapped | null>(tapped);
  useEffect(() => {
    tappedRef.current = tapped;
  }, [tapped]);
  const lastTakenTapRef = useRef<{ tap: Tapped; at: number } | null>(null);
  // Two-step verification. Set by the sign-in check below and by any server
  // answer of mfa_required (api.ts), for a password-only session on an
  // account with 2FA on; the code step then stands in for the app until the
  // code is in and the saved punches are sent. Keyed to the user, so it
  // never carries over to someone else.
  const [codeStep, setCodeStep] = useState<CodeStep | null>(null);
  // Bumped to ask for the status again (after the code step found 2FA off).
  const [statusNonce, setStatusNonce] = useState(0);
  const sessionRef = useRef<Session | null>(null);
  useEffect(() => {
    sessionRef.current = session;
  }, [session]);
  // A sign-out's last requests may answer mfa_required; they must not bring
  // the code step back over the sign-in screen.
  const signingOutRef = useRef(false);
  useEffect(() => {
    return onMfaRequired(() => {
      const current = sessionRef.current;
      const uid = current?.user?.id;
      if (!uid || signingOutRef.current) return;
      // A request sent with the password-only token just before the code
      // went in: this session no longer needs it.
      if (tokenAal(current.access_token) === "aal2") return;
      setCodeStep((cur) =>
        cur?.userId === uid ? cur : { userId: uid, phase: "code" },
      );
    });
  }, []);

  useEffect(() => {
    const sub = Notifications.addNotificationResponseReceivedListener((res) => {
      const t = takeTap(res);
      if (!t) return;
      // A tap that brings the app back after the grace period locks it in
      // the same render, so the manager tabs are gone before the tap could
      // reach them and it waits for the PIN (Android can deliver the tap
      // before the app is active again, iOS after).
      const since = bgSinceRef.current;
      if (
        lockConfiguredRef.current &&
        since != null &&
        Date.now() - since > LOCK_GRACE_MS
      ) {
        setLocked(true);
      }
      setTapped(t);
    });
    return () => sub.remove();
  }, []);

  const onTapHandled = useCallback(() => {
    const t = tappedRef.current;
    if (t) lastTakenTapRef.current = { tap: t, at: Date.now() };
    setTapped(null);
  }, []);

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
  useEffect(() => {
    const sub = AppState.addEventListener("change", (state) => {
      if (state === "active") {
        const since = bgSinceRef.current;
        bgSinceRef.current = null;
        if (since != null && Date.now() - since > LOCK_GRACE_MS) {
          // Lock at once from the status already known, so nothing behind
          // the lock (a notification tap included) runs first.
          if (lockConfiguredRef.current) setLocked(true);
          // Then re-read it (not on every tick) so a lock set up mid-session
          // arms without a restart, and a removed one stops locking.
          void getLockStatus().then((st) => {
            setLockStatus(st);
            setLocked(st.configured);
            if (!st.configured) return;
            // A lock set up in this session was not known above, so a tap
            // may have reached the manager tabs just before this lock took
            // them away. Give it to the tabs that mount after the PIN.
            const last = lastTakenTapRef.current;
            lastTakenTapRef.current = null;
            if (last && Date.now() - last.at < TAP_REPLAY_MS) {
              setTapped(last.tap);
            }
          });
        }
      } else if (state === "background" || state === "inactive") {
        if (bgSinceRef.current == null) bgSinceRef.current = Date.now();
        // Bring the known status up to date on the way out (a lock set up or
        // removed in this session), so the lock at once above is right.
        if (state === "background") void getLockStatus().then(setLockStatus);
      }
    });
    return () => sub.remove();
  }, []);

  // Guard the device-global punch queue across accounts: if the signed-in user
  // is not the one who enqueued the pending punches, clear them so they can't
  // drain under the wrong token. The common path (same user unlocking or
  // re-authenticating) matches and keeps the queue intact. The cached worksite
  // fences (fence-cache.ts) get the same account-switch guard.
  useEffect(() => {
    const uid = session?.user?.id;
    if (!uid) return;
    void (async () => {
      await clearFenceCacheUnlessOwner(uid);
      const owner = await getQueueOwner();
      if (owner && owner !== uid && (await storedPunchCount()) > 0) {
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
      // A password-only session on an account with 2FA on gets the code
      // step first. Asked alongside the status, so a phone without 2FA
      // waits no longer than before. Offline the check answers "unknown"
      // and the app carries on (punches queue as always); the server's
      // mfa_required answer brings up the same step once it is reachable.
      const userId = session.user.id;
      const check =
        tokenAal(t) === "aal2"
          ? Promise.resolve("clear" as const)
          : secondFactorNeeded(userId);
      try {
        const [need, res] = await Promise.all([
          check,
          getStatus(t).catch(() => null),
        ]);
        if (cancelled) return;
        if (need === "needed") {
          setCodeStep((cur) =>
            cur?.userId === userId ? cur : { userId, phase: "code" },
          );
          return;
        }
        if (!res) {
          // Offline or the request failed: keep the seeded role.
          setRole((cur) => cur ?? seeded ?? "employee");
        } else if (res.ok) {
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
        } else if (res.error !== MFA_REQUIRED) {
          // mfa_required has already brought up the code step (api.ts);
          // the role comes from the status asked again after the code.
          setRole((cur) => cur ?? seeded ?? "employee");
        }
      } catch {
        if (!cancelled) setRole((cur) => cur ?? seeded ?? "employee");
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [session, statusNonce]);

  const handleSignOut = async () => {
    signingOutRef.current = true;
    try {
      await signOutNow();
    } finally {
      signingOutRef.current = false;
    }
  };

  const signOutNow = async () => {
    setCodeStep(null);
    clearSecondFactorCache();
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
    await clearFenceCache();
    // Reminders are this person's: none may fire for whoever signs in next.
    await cancelAllReminders();
    await clearReminderPrefsCache();
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
      setCodeStep(null);
      clearSecondFactorCache();
      const t = await getAccessToken();
      if (t) await unregisterForPush(t);
      await clearBootSnapshot();
      await clearFenceCache();
      await cancelAllReminders();
      await clearReminderPrefsCache();
      await clearLock();
      setLockStatus({ configured: false, biometric: false, identity: null });
      setLocked(false);
      await supabase.auth.signOut();
    })();
  };

  const onUnlocked = () => setLocked(false);

  // The code went in: the session is aal2 now (supabase-js stored it and
  // onAuthStateChange passed it on). Send the punches saved while the server
  // was refusing this session, then hand over to the app, which reloads the
  // status for the new session. The step stays up while they send, so the
  // Clock screen never starts a second drain beside this one.
  const onCodeVerified = () => {
    setCodeStep((cur) => (cur ? { ...cur, phase: "sending" } : cur));
    void (async () => {
      let errors: string[] = [];
      const t = await getAccessToken();
      if (t) {
        const send = drainQueue(t).catch(() => null);
        let timer: ReturnType<typeof setTimeout> | null = null;
        const late = new Promise<null>((resolve) => {
          timer = setTimeout(() => resolve(null), CODE_SEND_BUDGET_MS);
        });
        const result = await Promise.race([send, late]);
        if (timer) clearTimeout(timer);
        errors = result?.errors ?? [];
      }
      setCodeStep(null);
      if (errors.length > 0) {
        Alert.alert(MFA_COPY.sentTitle, errors.join("\n\n"));
      }
    })();
  };

  // 2FA was turned off since the step came up: no code is needed, so ask
  // for the status again.
  const onNoFactor = () => {
    setCodeStep(null);
    setStatusNonce((n) => n + 1);
  };

  // Signing out from the code step clears the queue, and its punches can't
  // be sent without the code, so say so first when any are waiting.
  const onCodeStepSignOut = () => {
    void (async () => {
      const waiting = await queuedCount();
      if (waiting === 0) {
        await handleSignOut();
        return;
      }
      Alert.alert(MFA_COPY.signOutTitle, MFA_COPY.signOutWithPunches(waiting), [
        { text: MFA_COPY.cancel, style: "cancel" },
        {
          text: MFA_COPY.signOut,
          style: "destructive",
          onPress: () => void handleSignOut(),
        },
      ]);
    })();
  };

  // A tap the current shell has nothing to do with is dropped once the shell
  // is known: an employee (a demoted manager tapping an old alert, or a
  // reminder, which opens on the only screen they have), or no one signed
  // in. A manager's tap waits for ManagerTabs, which takes it on its own.
  const managerTab =
    tapped && role === "manager" ? tapTargetFor(tapped.data, true) : null;
  const tapUnclaimed =
    tapped !== null &&
    !loading &&
    (session === null || (role !== null && managerTab === null));
  // Adjusting state during render (React's pattern for state derived from
  // other state): the render restarts at once without the tap.
  if (tapUnclaimed) setTapped(null);

  // Signed in but role not resolved yet — hold on the spinner so we don't flash
  // the employee screen before swapping to the manager tabs.
  const resolvingRole = session !== null && role === null;
  const showCodeStep =
    session !== null && codeStep !== null && codeStep.userId === session.user.id;

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
        ) : showCodeStep ? (
          <MfaScreen
            sending={codeStep.phase === "sending"}
            onVerified={onCodeVerified}
            onNoFactor={onNoFactor}
            onSignOut={onCodeStepSignOut}
          />
        ) : resolvingRole ? (
          <View style={styles.center}>
            <ActivityIndicator color={lightColors.accent} size="large" />
          </View>
        ) : role === "manager" ? (
          <TutorialProvider role="manager" autoStart={!tutorialDone}>
            <ManagerTabs
              session={session}
              onSignOut={handleSignOut}
              pendingTab={managerTab}
              onPendingTabHandled={onTapHandled}
            />
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
