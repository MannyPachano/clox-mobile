import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  AccessibilityInfo,
  ActivityIndicator,
  Alert,
  AppState,
  InteractionManager,
  Modal,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from "react-native";
import NetInfo from "@react-native-community/netinfo";
import { SafeAreaView } from "react-native-safe-area-context";
import { StatusBar } from "expo-status-bar";

import type { Session } from "@supabase/supabase-js";

import {
  deleteAccount,
  getHistory,
  getMySchedule,
  getStatus,
  undoClockIn,
  type EditableEntry,
  type HistoryShift,
  type MyScheduledShift,
  type Option,
} from "../api";
import {
  CHECK_MS,
  UNDO_COPY,
  UNDO_DONE_NOTE_MS,
  UNDO_REQUEST_TIMEOUT_MS,
  UNDO_SEND_WAIT_MS,
  classifyUndoAnswer,
  formatElapsed,
  owedUndoOutcome,
  planUndo,
  rearmUndoOffer,
  syncLine,
  undoFailureMessage,
  undoNoticeMs,
  undoOfferClosesAt,
  undoSecondsLeft,
  withTimeout,
  type UndoAnswer,
  type UndoOffer,
  type UndoPlan,
} from "../clock-moment";
import { readFenceCache, writeFenceCache } from "../fence-cache";
import { precheckGeofence, type Fence } from "../geofence";
import { useAccessibilityPrefs } from "../lib/a11y-prefs";
import { haptics } from "../lib/haptics";
import { getOrgTz } from "../lib/org-tz";
import {
  clockInZone,
  clockWithDayInZone,
  orgWallClock,
  weekdayDateInZone,
} from "../lib/zoned-time";
import { SelectField } from "../components/SelectField";
import { SelfieCapture } from "../components/SelfieCapture";
import { DrawnCheck } from "../components/DrawnCheck";
import { HoldToClockOut } from "../components/HoldToClockOut";
import { PaletteBackdrop } from "../components/PaletteBackdrop";
import { EditEntryModal } from "../components/EditEntryModal";
import { RequestEditModal } from "../components/RequestEditModal";
import { Wordmark } from "../components/Wordmark";
import { LockSetupSheet } from "../components/LockSetupSheet";
import {
  RemindersSheet,
  type ReminderSupport,
} from "../components/RemindersSheet";
import { getPunchLocation, warmUpLocation } from "../location";
import {
  drainQueue,
  enqueuePunch,
  heldCount,
  queuedCount,
  removeHeldPunches,
  takeQueuedClockInForUndo,
  type QueuedPunch,
} from "../queue";
import {
  armReminders,
  clearReminderPrefsCache,
  disarmReminders,
  readReminderPrefsCache,
  syncLongShiftReminder,
  syncShiftReminders,
  writeReminderPrefsCache,
} from "../reminder-notifications";
import {
  isOn,
  parseReminderPrefs,
  PREFS_OFF,
  REMINDERS_BLOCKED_COPY,
  formatClock12,
  type ReminderPrefs,
} from "../reminders";
import { getNotificationAccess } from "../push";
import { askForLockScreenOnce } from "../notification-ask";
import { getAccessToken } from "../supabase";
import { getLockStatus, type LockStatus } from "../lib/app-lock";
import {
  darkColors,
  lightColors,
  normalizeThemePreference,
  resolvePalette,
  ThemeContext,
  type Palette,
  type ThemePreference,
} from "../theme";
import { useTutorial, useTutorialTarget } from "../tutorial/TutorialContext";
import { TutorialOverlay } from "../tutorial/TutorialOverlay";
import { newUuid } from "../uuid";
import { buildSimplePunch, type SimplePunchKind } from "../punch-builders";
import { subscribeSurfaceTaps } from "../shift-actions";
import { armShiftSurface, pushShiftSurface } from "../shift-surface";

// iOS only exposes the WiFi network name when this is on (plus the Access WiFi
// Information entitlement and precise location permission). Harmless on
// Android. Module-level so it runs once, before any clock-in.
NetInfo.configure({ shouldFetchWiFiSSID: true });

/** How the blocked-clock-in alert names the required network(s). */
function wifiNetworkNames(ssids: string[]): string {
  const named = ssids.map((s) => s.trim()).filter((s) => s.length > 0);
  if (named.length >= 1 && named.length <= 3) return named.join(" or ");
  return "one of the saved site networks";
}

// Shift times (history rows, upcoming scheduled) render in the ORG's zone
// via the shared zoned-time formatters, matching the edit modals they open
// and the web app. The live clock card is the one deliberate exception: it
// is the PHONE's clock, so it formats with tz undefined (device zone).

// Users told this app run that their reminders can't show because
// notifications are off (refresh). Module state, so an unlock (which mounts
// this screen again) doesn't say it again.
const remindersBlockedTold = new Set<string>();

/** What a lock-screen push needs besides the shift: names for "Project ·
 *  Task" and whether the org needs a project to clock out. */
type SurfaceNames = {
  projects: Option[];
  tasksByProject: Record<string, Option[]>;
  requireProject: boolean;
};

/** The shift a lock-screen push draws, in the screen's own terms. */
type SurfaceShiftNow = {
  startedAt: string | null;
  breakSince: string | null;
  projectId: string | null;
  taskId: string | null;
};

function isoMs(iso: string | null): number | null {
  if (!iso) return null;
  const ms = Date.parse(iso);
  return Number.isFinite(ms) ? ms : null;
}

/**
 * The mid-shift change question. The server's re-tag (applyToShift, web
 * repo retagActiveEntryCore) changes the current entry only. A "Switch from
 * now" splits the shift into two entries, so after one the current entry is
 * not the whole shift: the question then says which part changes and what
 * the earlier part keeps. `partSince` is the current part's start as a
 * clock time in the org's zone, "" when the zone is not known on this phone,
 * or null for a shift in one part.
 */
function switchQuestion(
  what: "project" | "task",
  partSince: string | null,
): { message: string; applyLabel: string } {
  if (partSince === null) {
    return {
      message: `You are on the clock. You can switch to the new ${what} from now, or apply it to the whole shift.`,
      applyLabel: "Apply to whole shift",
    };
  }
  const part = partSince
    ? `the part that started at ${partSince}`
    : "the current part only";
  return {
    message: `You are on the clock, and this shift has an earlier part. You can switch to the new ${what} from now, or apply it to ${part}. The earlier part keeps its ${what}.`,
    applyLabel: partSince ? `Apply since ${partSince}` : "Apply to this part",
  };
}

function formatDuration(ms: number): string {
  const min = Math.round((ms > 0 ? ms : 0) / 60000);
  const h = Math.floor(min / 60);
  const m = min % 60;
  return h > 0 ? `${h}h ${m}m` : `${m}m`;
}

type Props = {
  session: Session;
  onSignOut: () => void;
  /** True when rendered inside the manager shell (ManagerTabs). Drives whether
   *  tapping an own recent shift edits directly vs. requests a change. Comes
   *  from the shell that App.tsx already role-gated, not a re-fetch. */
  isManager?: boolean;
  /** Bumped by the manager shell whenever the Clock tab regains focus, so the
   *  screen refetches (e.g. to show a shift just edited on another tab). */
  focusNonce?: number;
};

export function ClockScreen({
  session,
  onSignOut,
  isManager = false,
  focusNonce,
}: Props) {
  const [userName, setUserName] = useState(session.user.email ?? "Employee");
  const [orgName, setOrgName] = useState("");
  const [shiftStartedAt, setShiftStartedAt] = useState<string | null>(null);
  const [onBreakSince, setOnBreakSince] = useState<string | null>(null);
  const [pending, setPending] = useState(0);
  // Punches kept on the phone because they are too old to sync on their own
  // (queue.ts holdReasonFor). They never count as waiting to sync.
  const [held, setHeld] = useState(0);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState("");
  const [banner, setBanner] = useState<string | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const [ready, setReady] = useState(false);

  // The clock-in moment (rules and copy in src/clock-moment.ts).
  // `landingId` is the clock-in whose check is drawing in the button: the
  // punch is saved and the shift state is set, but the screen keeps the
  // off-shift look for CHECK_MS, then flips.
  const [landingId, setLandingId] = useState<string | null>(null);
  const [undoOffer, setUndoOfferState] = useState<UndoOffer | null>(null);
  const [undoBusy, setUndoBusy] = useState(false);
  const [undoNote, setUndoNote] = useState<string | null>(null);
  const { screenReaderOn, reduceMotion } = useAccessibilityPrefs();
  // Mirrors of state that callbacks need at the moment they run.
  const undoOfferRef = useRef<UndoOffer | null>(null);
  const undoBusyRef = useRef(false);
  // Bumped whenever this phone changes the shift itself (a punch, an undo).
  // A refresh that started before the bump carries an older snapshot of the
  // server, so it must not overwrite the shift on screen.
  const localEpochRef = useRef(0);
  // Undo requests on their way to the server. Until one answers, the server
  // may still report that clock-in as running, so refreshes wait.
  const serverUndoCallsRef = useRef(0);
  // Keys of clock-ins this phone took out of its queue for an undo after a
  // send of them had started, whose server undo has had no final answer yet
  // (no connection, a server error). Each is asked again before every drain
  // until the server answers. `owedAskingRef` holds the ones being asked
  // right now, so two syncs never ask for the same one at once.
  const owedUndosRef = useRef(new Set<string>());
  const owedAskingRef = useRef(new Set<string>());
  // The first-run tour waits while the undo offer is up (see sync).
  const tutorialDueRef = useRef(false);
  // Android, decision 4: the one-time lock-screen notification question
  // waits for the clock-in to stand (its undo offer closing by itself). Any
  // other close (an undo, a clock-out or break in the window) drops it.
  const lockScreenAskDueRef = useRef(false);

  const [projects, setProjects] = useState<Option[]>([]);
  const [tasksByProject, setTasksByProject] = useState<
    Record<string, Option[]>
  >({});
  const [requireProject, setRequireProject] = useState(false);
  const [selfieRequired, setSelfieRequired] = useState(false);
  const [themePreference, setThemePreference] =
    useState<ThemePreference>("auto");
  const [cameraOpen, setCameraOpen] = useState(false);
  const [projectId, setProjectId] = useState<string | null>(null);
  const [taskId, setTaskId] = useState<string | null>(null);
  const [history, setHistory] = useState<HistoryShift[]>([]);
  const [upcoming, setUpcoming] = useState<MyScheduledShift[]>([]);
  const [editShift, setEditShift] = useState<HistoryShift | null>(null);
  const [requestShift, setRequestShift] = useState<HistoryShift | null>(null);
  const [accountMenuOpen, setAccountMenuOpen] = useState(false);
  const [lockSheetOpen, setLockSheetOpen] = useState(false);
  const [lockStatus, setLockStatus] = useState<LockStatus | null>(null);
  const refreshLock = useCallback(() => {
    void getLockStatus().then(setLockStatus);
  }, []);
  useEffect(() => {
    refreshLock();
  }, [refreshLock]);
  // Worksite fences for the client-side clock-in pre-check. Empty = no geofence.
  // Seeded on mount from the last good getStatus on disk (fence-cache.ts), so a
  // cold start with no signal can still warn an off-site worker; the live
  // refresh below replaces them and the saved copy. The seed never overwrites
  // fences a live refresh has already applied, whichever answers first.
  const [fences, setFences] = useState<Fence[]>([]);
  const liveFencesRef = useRef(false);
  const userId = session.user.id;
  useEffect(() => {
    let cancelled = false;
    void readFenceCache(userId).then((cached) => {
      if (cancelled || liveFencesRef.current || !cached) return;
      setFences(cached);
    });
    return () => {
      cancelled = true;
    };
  }, [userId]);
  // WiFi-restricted clock-in config. Unlike the geofence advisory this one
  // BLOCKS: only the phone can see the SSID, so the check lives here.
  const [wifi, setWifi] = useState<{ enforced: boolean; ssids: string[] }>({
    enforced: false,
    ssids: [],
  });
  // The RUNNING entry's id + start, for the start-time editor. Only set from
  // server truth (an offline optimistic clock-in has no entry id yet). Kept
  // referentially stable across refreshes so the editor's prefill effect only
  // refires when the entry actually changes.
  const [activeEntry, setActiveEntry] = useState<{
    id: string;
    start: string;
  } | null>(null);
  const [adjustOpen, setAdjustOpen] = useState(false);
  // The start of the running shift's CURRENT part, when the shift has an
  // earlier part: a "Switch from now" closes the entry and opens a new one,
  // and the server keeps the first tap as the shift anchor (startedAt), so
  // the new entry's own start (entryStartIso) is later. Null for a shift in
  // one part. Set from server truth at a refresh, and by a switch made here
  // before it syncs; cleared at a clock-in, a clock-out and an undo. The
  // change question reads it (switchQuestion): the server's re-tag changes
  // the current entry only, so "Apply to whole shift" is offered only when
  // that entry is the whole shift.
  const partStartRef = useRef<string | null>(null);
  // "" when the shift has an earlier part but the org zone is not known.
  const currentPartSince = useCallback((): string | null => {
    const iso = partStartRef.current;
    if (!iso) return null;
    const tz = getOrgTz();
    const wall = tz ? orgWallClock(Date.parse(iso), tz) : null;
    return (wall && formatClock12(wall)) || "";
  }, []);

  // Reminders (reminders.ts decides, reminder-notifications.ts schedules).
  // The preferences come from each status answer, or from the copy saved on
  // this phone until one arrives, so a clock-in after an offline cold start
  // still knows whether the long shift reminder is on. `support` is what the
  // Reminders screen shows: "unsupported" when the server predates the
  // preferences (the phone then schedules nothing).
  const [remindersOpen, setRemindersOpen] = useState(false);
  const [reminderPrefs, setReminderPrefs] = useState<ReminderPrefs | null>(
    null,
  );
  const [reminderSupport, setReminderSupport] =
    useState<ReminderSupport>("unknown");
  // What scheduling reads at the moment it runs. Null: not known on this
  // phone yet, so nothing new is scheduled (reminders.ts planners).
  const reminderPrefsRef = useRef<ReminderPrefs | null>(null);
  const livePrefsRef = useRef(false);
  // Bumped by every save on the Reminders screen. A refresh that started
  // before a save carries preferences older than the save's answer, so it
  // leaves them alone (a permission prompt brings the app back to the front,
  // which refreshes while the save is on its way).
  const prefsSaveSeqRef = useRef(0);
  // The last schedule loaded this session. Null until one loads.
  const upcomingRef = useRef<MyScheduledShift[] | null>(null);
  // A read-only mirror of shiftStartedAt for callbacks. Reminders are never
  // driven by this state changing: it starts null on every cold start and
  // stays null offline, which would cancel a valid long shift reminder.
  const shiftStartedAtRef = useRef<string | null>(null);
  useEffect(() => {
    shiftStartedAtRef.current = shiftStartedAt;
  }, [shiftStartedAt]);

  // The running shift on the Lock Screen, in the Dynamic Island, in the
  // widget and in the Android notification (shift-surface.ts). This screen
  // pushes only when it changes the shift itself (a clock-in, an undo, a
  // break, a project or task switch, a clock-out) and when a refresh applies
  // the server's answer; never on every render, since a cold start with
  // punches still queued shows Not clocked in until they send. A tap on one
  // of those surfaces is sent by shift-actions.ts, which draws its outcome
  // itself and tells this screen (the listener below). The mirrors let the
  // push callbacks see the shift as it is at the moment they run.
  const onBreakSinceRef = useRef<string | null>(null);
  const projectIdRef = useRef<string | null>(null);
  const taskIdRef = useRef<string | null>(null);
  const surfaceNamesRef = useRef<SurfaceNames>({
    projects: [],
    tasksByProject: {},
    requireProject: false,
  });
  useEffect(() => {
    onBreakSinceRef.current = onBreakSince;
  }, [onBreakSince]);
  useEffect(() => {
    projectIdRef.current = projectId;
    taskIdRef.current = taskId;
  }, [projectId, taskId]);
  useEffect(() => {
    surfaceNamesRef.current = { projects, tasksByProject, requireProject };
  }, [projects, tasksByProject, requireProject]);
  // Pushes draw only for the person this screen belongs to; sign-out and
  // re-authentication disarm before they clear (App.tsx).
  useEffect(() => {
    armShiftSurface(userId);
  }, [userId]);
  const pushSurface = useCallback(
    (shift: SurfaceShiftNow, names?: SurfaceNames) => {
      const n = names ?? surfaceNamesRef.current;
      const project = shift.projectId
        ? (n.projects.find((p) => p.id === shift.projectId) ?? null)
        : null;
      const task =
        shift.projectId && shift.taskId
          ? ((n.tasksByProject[shift.projectId] ?? []).find(
              (t) => t.id === shift.taskId,
            ) ?? null)
          : null;
      const startMs = isoMs(shift.startedAt);
      void pushShiftSurface({
        userId,
        shiftStartMs: startMs,
        breakStartMs: startMs === null ? null : isoMs(shift.breakSince),
        projectId: shift.projectId,
        projectName: project?.name ?? null,
        taskName: task?.name ?? null,
        requireProject: n.requireProject,
      });
    },
    [userId],
  );
  useEffect(() => {
    armReminders(userId);
    let cancelled = false;
    void readReminderPrefsCache(userId).then((cached) => {
      if (cancelled || livePrefsRef.current || !cached) return;
      reminderPrefsRef.current = cached;
      setReminderPrefs(cached);
      setReminderSupport("supported");
    });
    return () => {
      cancelled = true;
      disarmReminders(userId);
    };
  }, [userId]);

  // Preferences from the server: a status answer or a save. Null means the
  // server predates them, which reads as all off.
  const applyReminderPrefs = useCallback(
    (prefs: ReminderPrefs | null) => {
      livePrefsRef.current = true;
      if (prefs) {
        reminderPrefsRef.current = prefs;
        setReminderPrefs(prefs);
        setReminderSupport("supported");
        void writeReminderPrefsCache(userId, prefs);
      } else {
        reminderPrefsRef.current = PREFS_OFF;
        setReminderPrefs(null);
        setReminderSupport("unsupported");
        void clearReminderPrefsCache();
      }
    },
    [userId],
  );

  // The shift start reminders against the last schedule, in the ORG zone
  // (orgWallClock is null until the org zone is known, and then nothing new
  // is scheduled rather than a device-zone time).
  const reconcileShiftReminders = useCallback(
    (runningSince: string | null) => {
      const prefs = reminderPrefsRef.current;
      const tz = getOrgTz();
      void syncShiftReminders(userId, {
        minutes: prefs ? prefs.shiftReminderMinutes : undefined,
        shifts: upcomingRef.current,
        runningSinceMs: runningSince ? Date.parse(runningSince) : null,
        wallClock: tz ? (ms) => orgWallClock(ms, tz) : null,
      });
    },
    [userId],
  );

  // The long shift reminder for the running shift (null: none running).
  const reconcileLongShift = useCallback(
    (runningSince: string | null) => {
      const prefs = reminderPrefsRef.current;
      void syncLongShiftReminder(userId, {
        hours: prefs ? prefs.longShiftHours : undefined,
        runningSinceMs: runningSince ? Date.parse(runningSince) : null,
        isManager,
      });
    },
    [userId, isManager],
  );

  const refresh = useCallback(async () => {
    const token = await getAccessToken();
    if (!token) return;
    // Snapshot the queue BEFORE the round-trip too: if a punch drained to the
    // server mid-fetch, this status snapshot predates it, so we must not apply
    // it as truth (it would wipe the optimistic ON state).
    const queuedBefore = await queuedCount();
    const heldBefore = await heldCount();
    // The sync line follows the queue from the first screen on, not only
    // once a drain returns (a slow selfie upload can take a while).
    setPending(queuedBefore);
    setHeld(heldBefore);
    const epoch = localEpochRef.current;
    const prefsSeq = prefsSaveSeqRef.current;
    try {
      const [statusRes, historyRes, scheduleRes] = await Promise.all([
        getStatus(token),
        getHistory(token),
        getMySchedule(token),
      ]);
      if (statusRes.ok) {
        const d = statusRes.data;
        setOrgName(d.organization.name);
        setUserName(d.user.name);
        setRequireProject(d.organization.requireProject);
        setSelfieRequired(d.organization.selfieRequired);
        setThemePreference(normalizeThemePreference(d.themePreference));
        setProjects(d.projects);
        setTasksByProject(d.tasksByProject);
        const worksites = d.geofence?.worksites ?? [];
        liveFencesRef.current = true;
        setFences(worksites);
        void writeFenceCache(userId, worksites);
        setWifi(
          d.wifi
            ? { enforced: d.wifi.enforced, ssids: d.wifi.ssids ?? [] }
            : { enforced: false, ssids: [] },
        );
        if (prefsSeq === prefsSaveSeqRef.current) {
          const prefs = parseReminderPrefs(d.preferences);
          applyReminderPrefs(prefs);
          // Reminders that are on but can't show (turned on in web Settings,
          // where no permission is asked, or notifications turned off since)
          // are said in the banner once per app run. This never asks: the
          // ask stays on the Reminders screen. Once notifications are allowed
          // (every return from a prompt or Settings refreshes) or the
          // reminders are off, the banner goes.
          const anyOn =
            isOn(prefs, "shiftReminderMinutes") ||
            isOn(prefs, "longShiftHours") ||
            isOn(prefs, "notifyRefusedPunch");
          if (anyOn || remindersBlockedTold.has(userId)) {
            void getNotificationAccess().then((a) => {
              if (a.granted || !anyOn) {
                setBanner((b) => (b === REMINDERS_BLOCKED_COPY ? null : b));
              } else if (!remindersBlockedTold.has(userId)) {
                remindersBlockedTold.add(userId);
                setBanner(REMINDERS_BLOCKED_COPY);
              }
            });
          }
        }
        // Apply server truth only when the queue is empty — otherwise an
        // in-flight optimistic punch would be clobbered. (Also how a rejected
        // clock-in reverts: punch dropped → queue empty → server says "no
        // active shift" → optimistic timer clears.)
        // Nor after this phone changed the shift itself during the fetch (an
        // undo, or a punch that has already synced), or while an undo waits
        // on the server: this snapshot is older than what the phone shows.
        if (
          queuedBefore === 0 &&
          (await queuedCount()) === 0 &&
          epoch === localEpochRef.current &&
          serverUndoCallsRef.current === 0
        ) {
          const active = d.activeEntry;
          const runningSince = active?.startedAt ?? null;
          shiftStartedAtRef.current = runningSince;
          setShiftStartedAt(runningSince);
          setOnBreakSince(d.onBreakSince);
          setProjectId(active ? active.projectId : null);
          setTaskId(active ? active.taskId : null);
          setActiveEntry((prev) => {
            if (!active) return null;
            return prev &&
              prev.id === active.id &&
              prev.start === active.entryStartIso
              ? prev
              : { id: active.id, start: active.entryStartIso };
          });
          // The server sets the anchor only at a switch, so a later entry
          // start means an earlier part exists (an edited start moves both).
          partStartRef.current =
            active && active.entryStartIso !== active.startedAt
              ? active.entryStartIso
              : null;
          // Server truth for the running shift: schedule the long shift
          // reminder from its start, or cancel it when none is running (a
          // clock-out made on the web or by a manager, a clock-in the server
          // refused, a start time edited elsewhere).
          reconcileLongShift(runningSince);
          // And for the Lock Screen and the notification: this is how a
          // clock-in or clock-out made on the web, at a kiosk or by a
          // manager reaches them, and how a Live Activity comes back after
          // iOS ends it at 8 hours (shift-surface-state.ts planActivity).
          pushSurface(
            {
              startedAt: runningSince,
              breakSince: active ? d.onBreakSince : null,
              projectId: active ? active.projectId : null,
              taskId: active ? active.taskId : null,
            },
            {
              projects: d.projects,
              tasksByProject: d.tasksByProject,
              requireProject: d.organization.requireProject,
            },
          );
        }
      }
      if (historyRes.ok) setHistory(historyRes.data.shifts);
      if (scheduleRes.ok) {
        setUpcoming(scheduleRes.data.shifts);
        upcomingRef.current = scheduleRes.data.shifts;
      }
      // The phone's running shift as it is now, after the fetch: the
      // server's answer if it was applied above, or a punch made meanwhile.
      if (statusRes.ok || scheduleRes.ok) {
        reconcileShiftReminders(shiftStartedAtRef.current);
      }
    } catch {
      // Offline — keep optimistic local state.
    } finally {
      setReady(true);
    }
  }, [
    userId,
    applyReminderPrefs,
    reconcileLongShift,
    reconcileShiftReminders,
    pushSurface,
  ]);

  // Guided-tour replay + the first-run trigger (declared before sync so the
  // callback can fire it once a punch is accepted by the server).
  const { start: startTutorial, onPunchSucceeded } = useTutorial();

  const setUndoOffer = useCallback((offer: UndoOffer | null) => {
    undoOfferRef.current = offer;
    setUndoOfferState(offer);
  }, []);

  // Close the undo offer. A first-run tour held back by the offer opens now,
  // unless the clock-in was undone: then it waits for the next punch.
  const closeUndoOffer = useCallback(
    (undone: boolean) => {
      lockScreenAskDueRef.current = false;
      if (!undoOfferRef.current) return;
      setUndoOffer(null);
      if (tutorialDueRef.current) {
        tutorialDueRef.current = false;
        if (!undone) onPunchSucceeded();
      }
    },
    [setUndoOffer, onPunchSucceeded],
  );

  // Decision 4 (Android): once a clock-in stands, ask once whether the
  // running shift may show on the lock screen. After Allow, this screen's own
  // view of the shift goes to the notification at once: a refresh pushes only
  // with the queue empty, so an offline clock-in would otherwise wait for the
  // connection. It runs only right after this screen's own clock-in (the
  // undo offer closing by itself), never from a cold start's empty view.
  const offerLockScreenOnce = useCallback(async () => {
    const result = await askForLockScreenOnce(getAccessToken);
    if (result === "allowed") {
      pushSurface({
        startedAt: shiftStartedAtRef.current,
        breakSince: onBreakSinceRef.current,
        projectId: projectIdRef.current,
        taskId: taskIdRef.current,
      });
      void refresh();
    }
  }, [refresh, pushSurface]);

  // One undo request to the server for the clock-in sent with `key`. Null
  // when no answer came back (no connection, or none in time).
  const askServerUndo = useCallback(
    async (
      token: string,
      key: string,
    ): Promise<{ answer: UndoAnswer; code: string } | null> => {
      serverUndoCallsRef.current += 1;
      try {
        const res = await withTimeout(
          undoClockIn(token, key),
          UNDO_REQUEST_TIMEOUT_MS,
        );
        return { answer: classifyUndoAnswer(res), code: res.ok ? "" : res.error };
      } catch {
        return null;
      } finally {
        serverUndoCallsRef.current -= 1;
      }
    },
    [],
  );

  // Ask the server again for each undo this phone still owes
  // (owedUndosRef). The screen already shows Not clocked in for these, with
  // a banner saying the undo isn't confirmed. On a final answer the server
  // knows best, so refreshes may apply its state again (the epoch bump):
  //   done     say the undo went through.
  //   refused  the clock-in reached the server and stays; the next refresh
  //            shows the shift again and the banner says why.
  //   other    (a server without the undo route, a bad request) the send
  //            may or may not have landed; the next refresh shows which.
  const settleOwedUndos = useCallback(
    async (token: string) => {
      for (const key of Array.from(owedUndosRef.current)) {
        if (owedAskingRef.current.has(key)) continue;
        owedAskingRef.current.add(key);
        let result: { answer: UndoAnswer; code: string } | null;
        try {
          result = await askServerUndo(token, key);
        } finally {
          owedAskingRef.current.delete(key);
        }
        const outcome = owedUndoOutcome(result ? result.answer : null);
        if (outcome === "pending") continue;
        if (!owedUndosRef.current.delete(key)) continue;
        localEpochRef.current += 1;
        if (outcome === "done") {
          setBanner((b) =>
            b === UNDO_COPY.pending || b === UNDO_COPY.unauthorized ? null : b,
          );
          setUndoNote(UNDO_COPY.done);
          AccessibilityInfo.announceForAccessibility(UNDO_COPY.done);
        } else {
          setUndoNote(null);
          setBanner(
            result?.answer === "refused"
              ? UNDO_COPY.reachedServer
              : UNDO_COPY.unconfirmed,
          );
        }
      }
    },
    [askServerUndo],
  );

  const sync = useCallback(async () => {
    const token = await getAccessToken();
    if (!token) return;
    await settleOwedUndos(token);
    const result = await drainQueue(token);
    setPending(result.remaining);
    setHeld(result.held);
    if (result.errors.length > 0) setBanner(result.errors[0] ?? null);
    if (result.synced > 0) {
      // The first-run tour opens on the first punch the server accepts. It
      // must not cover the undo offer, so while the offer is up it waits.
      if (undoOfferRef.current) tutorialDueRef.current = true;
      else onPunchSucceeded();
    }
    await refresh();
  }, [refresh, onPunchSucceeded, settleOwedUndos]);

  useEffect(() => {
    void refresh();
    // Draining the offline punch queue is non-critical boot work — defer it
    // past the first render (Part D) so it never competes with paint.
    const task = InteractionManager.runAfterInteractions(() => {
      void sync();
    });
    return () => task.cancel();
  }, [refresh, sync]);

  // Warm the GPS on open so the first clock-in doesn't wait on a cold fix,
  // but only in the foreground. iOS can start the app in the background for
  // a Lock Screen or widget button, and this screen may mount then with
  // nobody looking: location is read only at a punch the person makes here,
  // never in the background. Such a start warms up at its first "active".
  useEffect(() => {
    if (AppState.currentState === "active") {
      void warmUpLocation();
      return;
    }
    let sub: { remove(): void } | null = AppState.addEventListener(
      "change",
      (state) => {
        if (state !== "active") return;
        sub?.remove();
        sub = null;
        void warmUpLocation();
      },
    );
    return () => {
      sub?.remove();
      sub = null;
    };
  }, []);

  const didFocusMountRef = useRef(false);
  useEffect(() => {
    // The manager shell bumps focusNonce when the Clock tab regains focus, so a
    // shift edited on another tab shows up here without reopening the app. Skip
    // the initial mount, which the effect above already covers.
    if (!didFocusMountRef.current) {
      didFocusMountRef.current = true;
      return;
    }
    void refresh();
  }, [focusNonce, refresh]);

  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, []);

  // The check shows for CHECK_MS, then the screen flips to on shift.
  useEffect(() => {
    if (!landingId) return;
    const t = setTimeout(() => setLandingId(null), CHECK_MS);
    return () => clearTimeout(t);
  }, [landingId]);

  // The undo offer closes by itself; never in the middle of an undo.
  useEffect(() => {
    if (!undoOffer || undoBusy) return;
    const t = setTimeout(
      () => {
        // Read both before closing: closeUndoOffer drops the ask, and may
        // open the first-run tour, which the question must not cover (it
        // then waits for a later clock-in).
        const askDue = lockScreenAskDueRef.current;
        const tourOpens = tutorialDueRef.current;
        closeUndoOffer(false);
        if (askDue && !tourOpens) void offerLockScreenOnce();
      },
      Math.max(0, undoOfferClosesAt(undoOffer) - Date.now()),
    );
    return () => clearTimeout(t);
  }, [undoOffer, undoBusy, closeUndoOffer, offerLockScreenOnce]);

  useEffect(() => {
    if (!undoNote) return;
    const t = setTimeout(() => setUndoNote(null), UNDO_DONE_NOTE_MS);
    return () => clearTimeout(t);
  }, [undoNote]);

  useEffect(() => {
    // If the running entry disappears while the start-time editor is open
    // (e.g. the server closed the shift), drop the editor flag too. Otherwise
    // the modal would pop back open on its own at the next clock-in.
    if (!activeEntry) setAdjustOpen(false);
  }, [activeEntry]);

  useEffect(() => {
    const appSub = AppState.addEventListener("change", (s) => {
      if (s === "active") {
        void refresh();
        void sync();
      }
    });
    const netUnsub = NetInfo.addEventListener((state) => {
      if (state.isConnected) void sync();
    });
    return () => {
      appSub.remove();
      netUnsub();
    };
  }, [refresh, sync]);

  // A Lock Screen, widget or notification tap, queued by shift-actions.ts.
  // It is this person's punch like one made here: the undo offer closes (an
  // undo would orphan it), a refresh that started before it must not undo
  // it on screen (the epoch bump), and the screen shows it at once, with the
  // same reminder changes a tap here makes. The surfaces draw the outcome
  // themselves; once it is known, the screen refreshes from the server.
  useEffect(() => {
    return subscribeSurfaceTaps((event) => {
      if (event.type === "notice") {
        setBanner(event.text);
        return;
      }
      if (event.userId !== userId) return;
      if (event.type === "queued") {
        closeUndoOffer(false);
        localEpochRef.current += 1;
        for (const tap of event.taps) {
          if (tap.kind === "out") {
            shiftStartedAtRef.current = null;
            setShiftStartedAt(null);
            setOnBreakSince(null);
            setActiveEntry(null);
            partStartRef.current = null;
            setLandingId(null);
            reconcileLongShift(null);
            reconcileShiftReminders(null);
          } else if (shiftStartedAtRef.current) {
            setOnBreakSince(
              tap.kind === "break_start" ? new Date(tap.tapMs).toISOString() : null,
            );
          }
        }
        void queuedCount().then(setPending);
        return;
      }
      if (event.drain) {
        setPending(event.drain.remaining);
        setHeld(event.drain.held);
        if (event.drain.errors.length > 0) setBanner(event.drain.errors[0] ?? null);
      }
      void refresh();
    });
  }, [userId, closeUndoOffer, reconcileLongShift, reconcileShiftReminders, refresh]);

  const enqueueSimple = useCallback(
    async (kind: SimplePunchKind) => {
      // Any later punch ends the undo offer: undoing the clock-in would
      // orphan this one.
      closeUndoOffer(false);
      localEpochRef.current += 1;
      // The same builder the lock-screen tap inbox uses, so a clock-out or
      // break from either place is the same punch.
      const punch = buildSimplePunch(kind, {
        id: newUuid(),
        clientTime: new Date().toISOString(),
        projectId,
      });
      try {
        await enqueuePunch(punch, userId);
      } catch {
        setBanner(
          "Couldn't save that. Check your phone's storage and try again.",
        );
        return;
      }
      setPending(await queuedCount());
      await sync();
    },
    [projectId, sync, closeUndoOffer, userId],
  );

  const enqueueSwitch = useCallback(
    async (
      nextProjectId: string | null,
      nextTaskId: string | null,
      applyToShift: boolean,
    ) => {
      closeUndoOffer(false);
      localEpochRef.current += 1;
      const punch: QueuedPunch = {
        id: newUuid(),
        kind: "switch_project",
        clientTime: new Date().toISOString(),
        projectId: nextProjectId,
        taskId: nextTaskId,
        note: null,
        selfie: null,
        latitude: null,
        longitude: null,
        accuracyM: null,
        mocked: null,
        ...(applyToShift ? { applyToShift: true } : {}),
      };
      try {
        await enqueuePunch(punch, userId);
      } catch {
        setBanner("Couldn't save the project switch. Try again.");
        return;
      }
      // Saved: from now the shift has an earlier part, until the next
      // refresh reads the server's own entry start.
      if (!applyToShift) partStartRef.current = punch.clientTime;
      setPending(await queuedCount());
      await sync();
    },
    [sync, closeUndoOffer, userId],
  );

  const onProjectChange = useCallback(
    (id: string | null) => {
      if (!shiftStartedAt) {
        setProjectId(id);
        setTaskId(null);
        return;
      }
      if (id === projectId) return;
      const apply = (applyToShift: boolean) => {
        setProjectId(id);
        setTaskId(null);
        pushSurface({
          startedAt: shiftStartedAtRef.current,
          breakSince: onBreakSinceRef.current,
          projectId: id,
          taskId: null,
        });
        void enqueueSwitch(id, null, applyToShift);
      };
      // Forgot-to-tag case: the running entry has no project yet, so the pick
      // simply labels it (the whole shift, unless an earlier part was
      // switched away from). No choice to make.
      if (projectId === null) {
        apply(true);
        return;
      }
      // Cancel reverts by doing nothing: the picker is controlled by state,
      // which only updates once a choice is made.
      const question = switchQuestion("project", currentPartSince());
      Alert.alert("Change project", question.message, [
        { text: "Switch from now", onPress: () => apply(false) },
        { text: question.applyLabel, onPress: () => apply(true) },
        { text: "Cancel", style: "cancel" },
      ]);
    },
    [shiftStartedAt, projectId, enqueueSwitch, pushSurface, currentPartSince],
  );

  const onTaskChange = useCallback(
    (id: string | null) => {
      if (!shiftStartedAt) {
        setTaskId(id);
        return;
      }
      if (id === taskId) return;
      const apply = (applyToShift: boolean) => {
        setTaskId(id);
        pushSurface({
          startedAt: shiftStartedAtRef.current,
          breakSince: onBreakSinceRef.current,
          projectId,
          taskId: id,
        });
        void enqueueSwitch(projectId, id, applyToShift);
      };
      const question = switchQuestion("task", currentPartSince());
      Alert.alert("Change task", question.message, [
        { text: "Switch from now", onPress: () => apply(false) },
        { text: question.applyLabel, onPress: () => apply(true) },
        { text: "Cancel", style: "cancel" },
      ]);
    },
    [shiftStartedAt, taskId, projectId, enqueueSwitch, pushSurface, currentPartSince],
  );

  const doClockIn = useCallback(
    async (selfie: string | null) => {
      setBusy(true);
      setBanner(null);
      // WiFi-restricted clock-in: the org can require punching in from a saved
      // site network. This check BLOCKS (no enqueue) and runs before anything
      // else — the phone is the only party that can read the SSID, and NetInfo
      // knows the network name even with no internet, so it works offline too.
      // Clock-out, breaks, and project switches are never gated.
      if (wifi.enforced && wifi.ssids.length > 0) {
        const names = wifiNetworkNames(wifi.ssids);
        const allowed = wifi.ssids.map((s) => s.trim());
        let blockMessage: string | null = null;
        try {
          const net = await NetInfo.fetch();
          const rawSsid =
            net.type === "wifi"
              ? ((net.details as { ssid?: string | null } | null)?.ssid ?? null)
              : null;
          const ssid = rawSsid === null ? null : rawSsid.trim();
          if (net.type !== "wifi") {
            blockMessage = `Your manager requires clock-in from the site WiFi network. Connect to ${names} and try again.`;
          } else if (ssid === null || ssid === "" || ssid === "<unknown ssid>") {
            // Android reports "<unknown ssid>" without precise location; iOS
            // returns null. Both mean the name could not be read.
            blockMessage =
              "Clox could not read the WiFi network name. Allow precise location for Clox in Settings, then try again.";
          } else if (!allowed.includes(ssid)) {
            blockMessage = `Your manager requires clock-in from the site WiFi network. Connect to ${names} and try again.`;
          }
        } catch {
          // Fail closed: enforcement lives entirely on this check, so an
          // unreadable network state can't be a bypass.
          blockMessage =
            "Clox could not check the WiFi network. Try again in a moment.";
        }
        if (blockMessage) {
          setBusy(false);
          Alert.alert("Connect to the site WiFi", blockMessage);
          return;
        }
      }
      const coords = await getPunchLocation();
      // Offline, the server can't tell the worker on the spot that they look
      // off-site — the punch would only fail on a later sync, after they've
      // left. So when there's no connection, warn now from the cached fences.
      // Advisory only and fail-open: this must never stop a clock-in.
      try {
        if (fences.length > 0) {
          const net = await NetInfo.fetch();
          if (!net.isConnected) {
            const check = precheckGeofence(coords, fences);
            if (check === "off_site") {
              setBanner(
                "Heads up: you look off the job site. If you're not on site, this clock-in won't count once you're back online.",
              );
            } else if (check === "no_location") {
              setBanner(
                "Heads up: Clox couldn't get your location. If you're on site, turn location on so this clock-in counts once you're back online.",
              );
            } else if (check === "inaccurate") {
              setBanner(
                "Heads up: your GPS signal is too weak to confirm the job site. Move into the open so this clock-in counts once you're back online.",
              );
            }
          }
        }
      } catch {
        // Advisory only — never block clocking in on a pre-check failure.
      }
      const punch: QueuedPunch = {
        id: newUuid(),
        kind: "in",
        clientTime: new Date().toISOString(),
        projectId,
        taskId,
        note: note.trim() ? note.trim() : null,
        selfie,
        latitude: coords.latitude,
        longitude: coords.longitude,
        accuracyM: coords.accuracyM,
        mocked: coords.mocked,
      };
      try {
        await enqueuePunch(punch, userId);
      } catch {
        setBusy(false);
        setBanner(
          "Couldn't save your clock-in. Check your phone's storage and try again.",
        );
        return;
      }
      // Saved. The check draws in the button with a light tap, and only now:
      // the WiFi check or a slow GPS fix above can still stop or delay a tap,
      // so the check means the punch is on the phone. The timer counts from
      // the tap time, so it reads 0:00:00 when the screen flips.
      haptics.light();
      localEpochRef.current += 1;
      setLandingId(punch.id);
      shiftStartedAtRef.current = punch.clientTime;
      setShiftStartedAt(punch.clientTime);
      setOnBreakSince(null);
      partStartRef.current = null;
      // The punch is saved on the phone, so this holds offline too: the long
      // shift reminder counts from the tap, and a shift reminder for the
      // shift this clock-in started early is cancelled.
      reconcileLongShift(punch.clientTime);
      reconcileShiftReminders(punch.clientTime);
      // The Live Activity starts now, anchored at the tap, offline too, and
      // any card left from an earlier shift ends at once. On Android the
      // notification posts if notifications are allowed.
      pushSurface({
        startedAt: punch.clientTime,
        breakSince: null,
        projectId,
        taskId,
      });
      // The new entry's server id is unknown until the punch syncs — clear any
      // stale one so the start-time editor can't target a previous entry.
      setActiveEntry(null);
      setNote("");
      setUndoNote(null);
      // Undo is offered from the flip, keyed to this punch's queue id, which
      // is also the idempotency key it is sent with.
      setUndoOffer({
        punchId: punch.id,
        tappedAt: punch.clientTime,
        shownAtMs: Date.now() + CHECK_MS,
        noticeMs: undoNoticeMs(screenReaderOn),
      });
      lockScreenAskDueRef.current = true;
      // With a screen reader on, focus moves to the offer once it shows (the
      // effect before the loading return), and its label says all of this.
      // Otherwise a short line, in case a reader is on but not detected yet.
      if (!screenReaderOn) {
        AccessibilityInfo.announceForAccessibility(UNDO_COPY.announceClockedIn);
      }
      // The punch is safely queued, so free the button now and send in the
      // background — the clock-in registers instantly instead of waiting on the
      // network round-trip. The offline queue guarantees delivery and retry.
      setBusy(false);
      setPending(await queuedCount());
      void sync();
    },
    [
      projectId,
      taskId,
      note,
      sync,
      fences,
      wifi,
      userId,
      screenReaderOn,
      setUndoOffer,
      reconcileLongShift,
      reconcileShiftReminders,
      pushSurface,
    ],
  );

  const onClockIn = useCallback(() => {
    // No haptic here: the light tap comes with the check, once the punch is
    // saved (doClockIn).
    if (selfieRequired) {
      setBanner(null);
      setCameraOpen(true);
      return;
    }
    void doClockIn(null);
  }, [selfieRequired, doClockIn]);

  const onSelfieUse = useCallback(
    (dataUrl: string) => {
      setCameraOpen(false);
      void doClockIn(dataUrl);
    },
    [doClockIn],
  );

  const onClockOut = useCallback(async () => {
    haptics.medium();
    setBusy(true);
    setBanner(null);
    shiftStartedAtRef.current = null;
    setShiftStartedAt(null);
    setOnBreakSince(null);
    setActiveEntry(null);
    partStartRef.current = null;
    // Clocked out on this phone: the long shift reminder goes now, offline
    // too, and shift reminders held while on the clock come back. If the
    // punch fails to save, the next refresh restores the reminder from the
    // server's running shift.
    reconcileLongShift(null);
    reconcileShiftReminders(null);
    // Clocked out in the app: the Live Activity and the notification end at
    // once (the final line is only for a clock-out made from them).
    pushSurface({
      startedAt: null,
      breakSince: null,
      projectId: projectIdRef.current,
      taskId: taskIdRef.current,
    });
    await enqueueSimple("out");
    setBusy(false);
  }, [enqueueSimple, reconcileLongShift, reconcileShiftReminders, pushSurface]);

  const onBreakStart = useCallback(async () => {
    haptics.light();
    setBusy(true);
    setBanner(null);
    const since = new Date().toISOString();
    setOnBreakSince(since);
    // On break: the surfaces count the break and say since when the shift
    // has run.
    pushSurface({
      startedAt: shiftStartedAtRef.current,
      breakSince: since,
      projectId: projectIdRef.current,
      taskId: taskIdRef.current,
    });
    await enqueueSimple("break_start");
    setBusy(false);
  }, [enqueueSimple, pushSurface]);

  // The held line is tappable: once the manager has added the shift, the
  // worker can remove the held punches from the phone.
  const onHeldPress = useCallback(() => {
    Alert.alert(
      held === 1 ? "Remove the held punch?" : "Remove the held punches?",
      "Only do this after your manager has added the shift. The held punches are deleted from this phone, and punches waiting to sync are kept.",
      [
        { text: "Keep", style: "cancel" },
        {
          text: "Remove",
          style: "destructive",
          onPress: () => {
            void removeHeldPunches().then(() => setHeld(0));
          },
        },
      ],
    );
  }, [held]);

  const onBreakEnd = useCallback(async () => {
    haptics.light();
    setBusy(true);
    setBanner(null);
    setOnBreakSince(null);
    pushSurface({
      startedAt: shiftStartedAtRef.current,
      breakSince: null,
      projectId: projectIdRef.current,
      taskId: taskIdRef.current,
    });
    await enqueueSimple("break_end");
    setBusy(false);
  }, [enqueueSimple, pushSurface]);

  // Back to Not clocked in after an undo, with no word on the outcome yet.
  // The project and task picks are kept for the next clock-in.
  const clearShiftOnPhone = useCallback(() => {
    localEpochRef.current += 1;
    shiftStartedAtRef.current = null;
    setShiftStartedAt(null);
    setOnBreakSince(null);
    setActiveEntry(null);
    partStartRef.current = null;
    setLandingId(null);
    closeUndoOffer(true);
    // Every "undone on this phone" outcome passes here: the clock-in's long
    // shift reminder goes, and held shift reminders come back.
    reconcileLongShift(null);
    reconcileShiftReminders(null);
    // The Live Activity and the notification end at once. If the server
    // turns out to have kept the clock-in, the refresh that shows it again
    // starts them again (the app is in the foreground).
    pushSurface({
      startedAt: null,
      breakSince: null,
      projectId: projectIdRef.current,
      taskId: taskIdRef.current,
    });
  }, [closeUndoOffer, reconcileLongShift, reconcileShiftReminders, pushSurface]);

  // The undo is done: the clock-in never reached the server, or the server
  // has undone it.
  const endShiftOnPhone = useCallback(() => {
    clearShiftOnPhone();
    setUndoNote(UNDO_COPY.done);
    AccessibilityInfo.announceForAccessibility(UNDO_COPY.done);
  }, [clearShiftOnPhone]);

  /**
   * Undo the clock-in the offer is for (clock-moment.ts planUndo):
   *   - still in the queue and never sent: take it out of the queue. That is
   *     the whole undo; the server never saw it.
   *   - still in the queue after a send started, and online: take it out of
   *     the queue first, so no sync can send it again, then undo it on the
   *     server by its key. The screen changes once the server answers. With
   *     no final answer, the screen shows Not clocked in with a banner that
   *     says the undo isn't confirmed, and each sync asks again.
   *   - out of the queue (sent and answered): undo it on the server by its
   *     key; the screen changes once the server agrees.
   *   - offline while the server has it or may have it: nothing changes.
   * Every outcome that asks the worker to try again keeps the offer up.
   */
  const onUndoPress = useCallback(async () => {
    const offer = undoOfferRef.current;
    if (!offer || undoBusyRef.current) return;
    undoBusyRef.current = true;
    setUndoBusy(true);
    setBanner(null);
    const tapMs = Date.now();
    // The offer starts over for another tap, unless something else closed
    // it meanwhile (a project switch, say).
    const keepOffer = () => {
      if (undoOfferRef.current?.punchId === offer.punchId) {
        setUndoOffer(rearmUndoOffer(offer, Date.now()));
      }
    };
    try {
      let online = true;
      try {
        online = (await NetInfo.fetch()).isConnected !== false;
      } catch {
        // Unknown: try the server, and a failed call says so.
      }

      let plan: UndoPlan | null;
      try {
        plan = await takeQueuedClockInForUndo(
          offer.punchId,
          (copy) =>
            planUndo({
              tappedAt: offer.tappedAt,
              nowMs: tapMs,
              queued: copy,
              online,
            }),
          UNDO_SEND_WAIT_MS,
        );
      } catch {
        // The queue could not be read or written. Nothing was removed.
        setBanner(UNDO_COPY.unknown);
        keepOffer();
        return;
      }

      if (plan === null) {
        // A send of this clock-in is still waiting for an answer.
        setBanner(UNDO_COPY.unreachable);
        keepOffer();
        return;
      }
      if (plan === "too_late" || plan === "changed") {
        closeUndoOffer(false);
        setBanner(UNDO_COPY.refusals[plan] ?? UNDO_COPY.unknown);
        return;
      }
      if (plan === "offline") {
        setBanner(UNDO_COPY.offline);
        keepOffer();
        return;
      }
      if (plan === "local") {
        endShiftOnPhone();
        setPending(await queuedCount());
        void sync();
        return;
      }

      const token = await getAccessToken();

      if (plan === "local_then_server") {
        // The phone's copy is gone, so no sync can send it again. The send
        // that was started may have landed, so the screen waits for the
        // server's answer before it says anything.
        setPending(await queuedCount());
        const result = token ? await askServerUndo(token, offer.punchId) : null;
        const answer: UndoAnswer | null = token
          ? (result?.answer ?? null)
          : "unauthorized";
        const outcome = owedUndoOutcome(answer);
        if (outcome === "done") {
          endShiftOnPhone();
          void sync();
          return;
        }
        if (outcome === "final") {
          // The server's state stands. A refusal means the clock-in landed;
          // any other answer leaves it unknown, and the refresh shows which.
          localEpochRef.current += 1;
          closeUndoOffer(false);
          setBanner(
            answer === "refused" && result
              ? undoFailureMessage("refused", result.code)
              : UNDO_COPY.unconfirmed,
          );
          void sync();
          return;
        }
        // No final answer yet. Nothing on this phone can send the clock-in
        // any more, so the screen shows Not clocked in, the banner says the
        // undo isn't confirmed, and each sync asks the server again.
        owedUndosRef.current.add(offer.punchId);
        clearShiftOnPhone();
        setBanner(
          answer === "unauthorized"
            ? UNDO_COPY.unauthorized
            : UNDO_COPY.pending,
        );
        return;
      }

      // plan === "server"
      if (!token) {
        closeUndoOffer(false);
        setBanner(UNDO_COPY.unauthorized);
        return;
      }
      const result = await askServerUndo(token, offer.punchId);
      if (result === null) {
        setBanner(UNDO_COPY.unreachable);
        keepOffer();
        return;
      }
      if (result.answer === "done") {
        endShiftOnPhone();
        void refresh();
        return;
      }
      if (result.answer === "retry") {
        setBanner(UNDO_COPY.unknown);
        keepOffer();
        return;
      }
      closeUndoOffer(false);
      setBanner(undoFailureMessage(result.answer, result.code));
      void refresh();
    } finally {
      undoBusyRef.current = false;
      setUndoBusy(false);
    }
  }, [
    askServerUndo,
    clearShiftOnPhone,
    closeUndoOffer,
    endShiftOnPhone,
    refresh,
    setUndoOffer,
    sync,
  ]);

  // Guided-tour anchors (measured by the spotlight overlay).
  const clockInRef = useTutorialTarget("clockIn");
  const projectRef = useTutorialTarget("project");
  const historyRef = useTutorialTarget("history");
  const scheduleRef = useTutorialTarget("schedule");

  // The shift is on from the moment the punch is saved, but the screen shows
  // it once the check has had its moment.
  const clockedIn = shiftStartedAt !== null && landingId === null;
  const palette = resolvePalette(themePreference, clockedIn);
  const isDark = palette === darkColors;
  const styles = useMemo(() => makeStyles(palette), [palette]);
  const onBreak = onBreakSince !== null;
  const undoVisible = undoOffer !== null && clockedIn && !onBreak;

  // With a screen reader on, the Clock in button that had focus is gone at
  // the flip, and the offer sits after the whole scrolling list, many swipes
  // away. So focus moves to the offer's prompt as it shows; its label reads
  // the whole offer, and one swipe reaches the Undo button. Hooks stay above
  // the loading return (Hermes rule, see handleDeleteAccount below).
  const undoPromptRef = useRef<Text>(null);
  const undoShowing = ready && undoVisible;
  useEffect(() => {
    if (!screenReaderOn || !undoShowing) return;
    const t = setTimeout(() => {
      const prompt = undoPromptRef.current;
      if (prompt) AccessibilityInfo.sendAccessibilityEvent(prompt, "focus");
      else AccessibilityInfo.announceForAccessibility(UNDO_COPY.announceOffer);
    }, 150);
    return () => clearTimeout(t);
  }, [screenReaderOn, undoShowing]);

  // Every banner is spoken, undo outcomes included: the banner is not a live
  // region on iOS, and several undo outcomes also take the offer (and the
  // focus on it) away. `queue` waits for VoiceOver's current speech instead
  // of cutting in (iOS only; Android ignores it).
  useEffect(() => {
    if (banner) {
      AccessibilityInfo.announceForAccessibilityWithOptions(banner, {
        queue: true,
      });
    }
  }, [banner]);

  // A STABLE entry object for the manager's own-shift editor. Passing a fresh
  // object literal each render would re-fire EditEntryModal's prefill effect on
  // every timer tick and clobber the manager's in-progress time change.
  const editEntry = useMemo(
    () =>
      editShift
        ? {
            id: editShift.id,
            start: editShift.start,
            end: editShift.end,
            projectId: editShift.projectId,
            note: editShift.note,
          }
        : null,
    [editShift],
  );

  // The RUNNING entry shaped for the manager's start-only editor. Memoized for
  // the same reason as editEntry above (activeEntry is already kept
  // referentially stable across refreshes).
  const runningEditEntry = useMemo<EditableEntry | null>(
    () =>
      activeEntry
        ? {
            id: activeEntry.id,
            start: activeEntry.start,
            projectId: null,
            note: null,
          }
        : null,
    [activeEntry],
  );

  // A switch on the Reminders screen saved: apply what the server saved and
  // bring both kinds of reminder in line with it. Above the loading return
  // like every hook here (Hermes rule, see handleDeleteAccount below).
  const onRemindersSaved = useCallback(
    (prefs: ReminderPrefs) => {
      prefsSaveSeqRef.current += 1;
      applyReminderPrefs(prefs);
      reconcileLongShift(shiftStartedAtRef.current);
      reconcileShiftReminders(shiftStartedAtRef.current);
    },
    [applyReminderPrefs, reconcileLongShift, reconcileShiftReminders],
  );

  // Declared BEFORE the early `if (!ready) return` below so the number of hooks
  // is identical on every render. A hook after a conditional return changes the
  // hook count between renders and throws "Rendered more hooks than during the
  // previous render," which hard-crashes a release (Hermes) build.
  const handleDeleteAccount = useCallback(() => {
    const runDelete = () => {
      void (async () => {
        const token = await getAccessToken();
        if (!token) {
          Alert.alert("Sign in required", "Please sign in again and retry.");
          return;
        }
        const res = await deleteAccount(token);
        if (res.ok) {
          onSignOut();
          return;
        }
        const message =
          res.error === "is_owner"
            ? "You own this organization. Transfer ownership or delete the organization first. You can do that on the web app under Settings."
            : res.error === "last_manager"
              ? "You're the only manager. Add another manager before deleting your account."
              : "Something went wrong deleting your account. Please try again, or contact support.";
        Alert.alert("Couldn't delete account", message);
      })();
    };

    // Two-step confirmation. This is irreversible and its entry point sits in
    // the same sheet as Sign out, so it must never complete on a single tap.
    Alert.alert(
      "Delete my account",
      "This permanently deletes your login and personal details. Your past " +
        "time entries stay with your employer for payroll but can no longer be " +
        "tied to you. This can't be undone.",
      [
        { text: "Cancel", style: "cancel" },
        {
          text: "Continue",
          style: "destructive",
          onPress: () => {
            Alert.alert(
              "Are you sure?",
              "Deleting your account is permanent and can't be undone.",
              [
                { text: "Cancel", style: "cancel" },
                {
                  text: "Delete my account",
                  style: "destructive",
                  onPress: runDelete,
                },
              ],
            );
          },
        },
      ],
    );
  }, [onSignOut]);

  if (!ready) {
    return (
      <SafeAreaView style={[styles.container, styles.center]}>
        <StatusBar style={isDark ? "light" : "dark"} />
        <ActivityIndicator color={palette.accent} size="large" />
      </SafeAreaView>
    );
  }

  const elapsed = shiftStartedAt ? now - Date.parse(shiftStartedAt) : 0;
  const breakElapsed = onBreakSince ? now - Date.parse(onBreakSince) : 0;
  const tasksForProject = projectId ? tasksByProject[projectId] ?? [] : [];
  const projectMissing = !clockedIn && requireProject && !projectId;
  const showPickers = !onBreak;
  const line = syncLine({ pending, held });
  const undoLeft = undoOffer ? undoSecondsLeft(undoOffer, now) : 0;
  const punchBusy = busy || undoBusy;

  return (
    <ThemeContext.Provider value={palette}>
      <View style={styles.root}>
        {/* The background cross-fades between palettes; the SafeAreaView on
            top of it is transparent. */}
        <PaletteBackdrop dark={isDark} reduceMotion={reduceMotion} />
        <SafeAreaView style={styles.safe} edges={["top", "bottom"]}>
          <StatusBar style={isDark ? "light" : "dark"} />
          <View style={styles.header}>
            <Wordmark palette={palette} size={22} />
            <TouchableOpacity
              onPress={() => setAccountMenuOpen(true)}
              hitSlop={10}
              accessibilityRole="button"
              accessibilityLabel="Account menu"
              style={styles.avatarBtn}
            >
              <Text style={styles.avatarInitial}>
                {(userName || "U").trim().charAt(0).toUpperCase()}
              </Text>
            </TouchableOpacity>
          </View>

          <View style={styles.main}>
            <ScrollView
              contentContainerStyle={styles.body}
              keyboardShouldPersistTaps="handled"
            >
              <View style={styles.greeting}>
                <Text style={styles.hello} numberOfLines={1}>
                  {userName}
                </Text>
                {orgName ? (
                  <Text style={styles.org} numberOfLines={1}>
                    {orgName}
                  </Text>
                ) : null}
              </View>

              <View
                style={[
                  styles.statusCard,
                  !clockedIn
                    ? styles.statusCardOff
                    : onBreak
                      ? styles.statusCardBreak
                      : styles.statusCardOn,
                ]}
              >
                {!clockedIn ? (
                  <>
                    <Text style={styles.statusLabel}>NOT CLOCKED IN</Text>
                    {/* The phone's own clock — device zone on purpose. */}
                    <Text style={styles.clockNow}>{clockInZone(now, undefined)}</Text>
                    <Text style={styles.dateNow}>
                      {weekdayDateInZone(now, undefined)}
                    </Text>
                  </>
                ) : (
                  <>
                    <Text style={styles.statusLabel}>
                      {onBreak ? "ON BREAK" : "ON THE CLOCK"}
                    </Text>
                    <Text style={styles.timer}>
                      {onBreak
                        ? formatElapsed(breakElapsed)
                        : formatElapsed(elapsed)}
                    </Text>
                    {onBreak ? (
                      <Text style={styles.subMeta}>
                        Shift running · {formatElapsed(elapsed)}
                      </Text>
                    ) : null}
                    {activeEntry ? (
                      // Hidden until the clock-in has synced: an offline punch has
                      // no server entry id to adjust yet.
                      <TouchableOpacity
                        onPress={() => setAdjustOpen(true)}
                        hitSlop={8}
                        accessibilityRole="button"
                        accessibilityLabel="Adjust start time"
                      >
                        {/* The underline is a clay border on a wrapper, not
                            textDecorationColor, which Android ignores. */}
                        <View style={styles.adjustLinkLine}>
                          <Text style={styles.adjustLink}>Adjust start time</Text>
                        </View>
                      </TouchableOpacity>
                    ) : null}
                  </>
                )}
              </View>

              {showPickers ? (
                <>
                  <View ref={projectRef}>
                    <SelectField
                      label="Project"
                      value={projectId}
                      options={projects}
                      placeholder={
                        requireProject
                          ? "Choose a project (required)"
                          : "No project"
                      }
                      onSelect={onProjectChange}
                      noneLabel={requireProject ? undefined : "No project"}
                    />
                  </View>
                  {projectId && tasksForProject.length > 0 ? (
                    <SelectField
                      label="Task"
                      value={taskId}
                      options={tasksForProject}
                      placeholder="No task"
                      onSelect={onTaskChange}
                      noneLabel="No task"
                    />
                  ) : null}
                  {clockedIn ? (
                    <Text style={styles.switchHint}>
                      Changing the project switches your shift from now, or you can
                      apply it to the whole shift.
                    </Text>
                  ) : null}
                </>
              ) : null}

              {!clockedIn ? (
                <>
                  <TextInput
                    style={styles.note}
                    placeholder="Add a note (optional)"
                    placeholderTextColor={palette.textMuted}
                    value={note}
                    onChangeText={setNote}
                    editable={!busy}
                  />
                  <TouchableOpacity
                    ref={clockInRef}
                    style={[
                      styles.bigButton,
                      styles.inButton,
                      (punchBusy || projectMissing) && styles.buttonDisabled,
                    ]}
                    onPress={onClockIn}
                    disabled={punchBusy || projectMissing || landingId !== null}
                    activeOpacity={0.85}
                    accessibilityRole="button"
                    accessibilityLabel={
                      landingId !== null
                        ? "Clocked in"
                        : selfieRequired
                          ? "Clock in with selfie"
                          : "Clock in"
                    }
                    accessibilityState={{
                      disabled:
                        punchBusy || projectMissing || landingId !== null,
                      busy,
                    }}
                  >
                    {landingId !== null ? (
                      // The punch is saved: a check draws in, then the flip.
                      <View style={styles.landingRow}>
                        <DrawnCheck
                          color={palette.accentText}
                          animate={!reduceMotion}
                        />
                        <Text
                          style={[
                            styles.bigButtonText,
                            { color: palette.accentText },
                          ]}
                        >
                          Clocked in
                        </Text>
                      </View>
                    ) : busy ? (
                      <ActivityIndicator color={palette.accentText} />
                    ) : (
                      <Text
                        style={[styles.bigButtonText, { color: palette.accentText }]}
                      >
                        {selfieRequired ? "Clock in with selfie" : "Clock in"}
                      </Text>
                    )}
                  </TouchableOpacity>
                </>
              ) : (
                <>
                  <TouchableOpacity
                    style={[
                      styles.bigButton,
                      styles.breakButton,
                      punchBusy && styles.buttonDisabled,
                    ]}
                    onPress={onBreak ? onBreakEnd : onBreakStart}
                    disabled={punchBusy}
                    activeOpacity={0.85}
                    accessibilityRole="button"
                  >
                    <Text style={[styles.bigButtonText, { color: palette.text }]}>
                      {onBreak ? "End break" : "Take break"}
                    </Text>
                  </TouchableOpacity>
                  {screenReaderOn ? (
                    // A screen reader activates with a double tap, which is
                    // already a deliberate step, and holding through one is
                    // awkward (VoiceOver needs a double tap and hold, TalkBack
                    // may not pass the press through at all). So with a screen
                    // reader on, Clock out is a plain button and hold is not
                    // offered next to it, which would read out two controls
                    // that do the same thing.
                    <TouchableOpacity
                      style={[
                        styles.bigButton,
                        styles.outButton,
                        styles.buttonStacked,
                        punchBusy && styles.buttonDisabled,
                      ]}
                      onPress={onClockOut}
                      disabled={punchBusy}
                      activeOpacity={0.85}
                      accessibilityRole="button"
                      accessibilityLabel="Clock out"
                      accessibilityState={{ disabled: punchBusy, busy }}
                    >
                      {busy ? (
                        <ActivityIndicator color={palette.accentText} />
                      ) : (
                        <Text
                          style={[
                            styles.bigButtonText,
                            { color: palette.accentText },
                          ]}
                        >
                          Clock out
                        </Text>
                      )}
                    </TouchableOpacity>
                  ) : (
                    <HoldToClockOut
                      // A fresh button per shift, so a finished hold never
                      // carries over.
                      key={shiftStartedAt ?? "off"}
                      onComplete={() => void onClockOut()}
                      disabled={punchBusy}
                      trackColor={palette.dangerTrack}
                      fillColor={palette.dangerFill}
                      textColor={palette.accentText}
                      style={[
                        styles.bigButton,
                        styles.buttonStacked,
                        punchBusy && styles.buttonDisabled,
                      ]}
                      textStyle={styles.bigButtonText}
                    />
                  )}
                </>
              )}

              {projectMissing ? (
                <Text style={styles.requireHint}>
                  {projects.length === 0
                    ? "Your organization requires a project to clock in, but none have been set up yet. Ask your manager to add a project on the Clox website."
                    : "Pick a project to clock in."}
                </Text>
              ) : line.kind === "none" ? null : (
                // Driven by the queue: amber while a punch is saved on this
                // phone, green once none are waiting (queue.ts queuedCount).
                <View style={styles.syncRow} accessibilityLiveRegion="polite">
                  <View
                    style={[
                      styles.syncDot,
                      {
                        backgroundColor:
                          line.kind === "saved" ? palette.warn : palette.success,
                      },
                    ]}
                  />
                  <Text
                    style={line.kind === "saved" ? styles.pending : styles.synced}
                  >
                    {line.text}
                  </Text>
                </View>
              )}

              {held > 0 ? (
                <TouchableOpacity
                  onPress={onHeldPress}
                  accessibilityRole="button"
                  accessibilityHint="Removes the held punches after your manager has added the shift"
                >
                  <Text style={styles.held}>
                    {held === 1
                      ? "1 punch is held on this phone because it is too old to sync by itself. Ask your manager to add that shift, then tap here to remove it."
                      : `${held} punches are held on this phone because they are too old to sync by themselves. Ask your manager to add that shift, then tap here to remove them.`}
                  </Text>
                </TouchableOpacity>
              ) : null}

              {upcoming.length > 0 ? (
                <View ref={scheduleRef} style={styles.history}>
                  <Text style={styles.historyTitle}>Upcoming shifts</Text>
                  {upcoming.slice(0, 3).map((s) => (
                    <View key={s.id} style={styles.historyRow}>
                      <View style={styles.historyLeft}>
                        <Text style={styles.historyDate}>
                          {weekdayDateInZone(Date.parse(s.startsAt), getOrgTz())}
                        </Text>
                        <Text style={styles.historySub} numberOfLines={1}>
                          {clockInZone(Date.parse(s.startsAt), getOrgTz())} to{" "}
                          {clockWithDayInZone(
                            Date.parse(s.endsAt),
                            Date.parse(s.startsAt),
                            getOrgTz(),
                          )}
                        </Text>
                      </View>
                    </View>
                  ))}
                  {upcoming.length > 3 ? (
                    <Text style={styles.upcomingMore}>
                      + {upcoming.length - 3} more scheduled
                    </Text>
                  ) : null}
                </View>
              ) : null}

              {history.length > 0 ? (
                <View ref={historyRef} style={styles.history}>
                  <Text style={styles.historyTitle}>Recent shifts</Text>
                  {history.map((s) => (
                    <TouchableOpacity
                      key={s.id}
                      style={styles.historyRow}
                      onPress={() =>
                        isManager ? setEditShift(s) : setRequestShift(s)
                      }
                      activeOpacity={0.6}
                    >
                      <View style={styles.historyLeft}>
                        <View style={styles.historyDateRow}>
                          <Text style={styles.historyDate}>
                            {weekdayDateInZone(Date.parse(s.start), getOrgTz())}
                          </Text>
                          {s.rejected ? (
                            <View style={styles.rejectedBadge}>
                              <Text style={styles.rejectedBadgeText}>REJECTED</Text>
                            </View>
                          ) : null}
                        </View>
                        <Text style={styles.historySub} numberOfLines={1}>
                          {clockInZone(Date.parse(s.start), getOrgTz())} to{" "}
                          {clockWithDayInZone(
                            Date.parse(s.end),
                            Date.parse(s.start),
                            getOrgTz(),
                          )}
                          {s.project ? ` · ${s.project}` : ""}
                        </Text>
                        {s.rejected ? (
                          <Text style={styles.rejectedReason} numberOfLines={2}>
                            {s.rejectionReason
                              ? `Reason: “${s.rejectionReason}”. Tap to fix and resubmit.`
                              : "Tap to correct and resubmit."}
                          </Text>
                        ) : null}
                      </View>
                      <Text
                        style={[
                          styles.historyDur,
                          s.rejected && styles.historyDurRejected,
                        ]}
                      >
                        {formatDuration(s.durationMs)}
                      </Text>
                      <Text style={styles.historyChevron}>›</Text>
                    </TouchableOpacity>
                  ))}
                </View>
              ) : null}

              <Text style={styles.offlineHint}>
                Works offline. Your punch is saved on this phone and syncs
                automatically when you&apos;re back online.
              </Text>
            </ScrollView>

            {undoVisible || undoNote ? (
              // Floats over the bottom of the screen like the mockup's toast,
              // on the paper palette in either theme so it stands off the
              // dark on-shift screen. Not a live region: the offer gets focus
              // and the done note is announced, and a live region on top
              // would make TalkBack read them twice.
              <View style={styles.undoCard}>
                {undoVisible ? (
                  <>
                    <Text
                      ref={undoPromptRef}
                      style={styles.undoText}
                      accessibilityLabel={
                        screenReaderOn ? UNDO_COPY.announceOffer : undefined
                      }
                    >
                      {UNDO_COPY.prompt}
                      {/* The countdown is left out for screen readers, which
                          would read every second of it. */}
                      {!screenReaderOn && undoLeft > 0 ? (
                        <Text style={styles.undoCount}>
                          {`  ${undoLeft}s`}
                        </Text>
                      ) : null}
                    </Text>
                    <TouchableOpacity
                      style={[
                        styles.undoButton,
                        undoBusy && styles.buttonDisabled,
                      ]}
                      onPress={() => void onUndoPress()}
                      disabled={undoBusy}
                      activeOpacity={0.8}
                      accessibilityRole="button"
                      // No separate label: the spoken name is the visible
                      // text ("Undo clock-in", or "Undoing…" while busy).
                      accessibilityState={{
                        disabled: undoBusy,
                        busy: undoBusy,
                      }}
                    >
                      <Text style={styles.undoButtonText}>
                        {undoBusy ? UNDO_COPY.busy : UNDO_COPY.button}
                      </Text>
                    </TouchableOpacity>
                  </>
                ) : (
                  <Text style={styles.undoText}>{undoNote}</Text>
                )}
              </View>
            ) : null}
          </View>

          <SelfieCapture
            visible={cameraOpen}
            onCancel={() => setCameraOpen(false)}
            onUse={onSelfieUse}
          />

          <EditEntryModal
            visible={editShift !== null}
            entry={editEntry}
            onClose={() => setEditShift(null)}
            onSaved={() => {
              setEditShift(null);
              void refresh();
            }}
          />

          <RequestEditModal
            visible={requestShift !== null}
            shift={requestShift}
            onClose={() => setRequestShift(null)}
            onSubmitted={() => {
              setRequestShift(null);
              setBanner("Change requested. Your manager will review it.");
            }}
          />

          {/* Start-time adjustment for the RUNNING shift. Managers edit the
              entry directly; everyone else files a correction request that a
              manager approves. */}
          {isManager ? (
            <EditEntryModal
              visible={adjustOpen && runningEditEntry !== null}
              entry={runningEditEntry}
              startOnly
              onClose={() => setAdjustOpen(false)}
              onSaved={() => {
                setAdjustOpen(false);
                // The timer anchors on the server's startedAt. Refetch and show
                // whatever the server returns instead of computing locally.
                void refresh();
              }}
            />
          ) : (
            <RequestEditModal
              visible={adjustOpen && activeEntry !== null}
              shift={null}
              startOnly
              running={activeEntry}
              onClose={() => setAdjustOpen(false)}
              onSubmitted={() => {
                setAdjustOpen(false);
                setBanner(
                  "Sent. Your manager approves this before it changes your timesheet.",
                );
              }}
            />
          )}

          <Modal
            visible={accountMenuOpen}
            transparent
            animationType="fade"
            onRequestClose={() => setAccountMenuOpen(false)}
          >
            <TouchableOpacity
              style={styles.sheetBackdrop}
              activeOpacity={1}
              onPress={() => setAccountMenuOpen(false)}
            >
              <TouchableOpacity activeOpacity={1} style={styles.sheetCard}>
                <Text style={styles.sheetName} numberOfLines={1}>
                  {userName}
                </Text>
                {orgName ? (
                  <Text style={styles.sheetSub} numberOfLines={1}>
                    {orgName}
                  </Text>
                ) : null}
                {session.user.email ? (
                  <Text style={styles.sheetEmail} numberOfLines={1}>
                    {session.user.email}
                  </Text>
                ) : null}

                <View style={styles.sheetDivider} />

                <TouchableOpacity
                  style={styles.sheetRow}
                  onPress={() => {
                    setAccountMenuOpen(false);
                    startTutorial();
                  }}
                >
                  <Text style={styles.sheetRowText}>Replay tutorial</Text>
                </TouchableOpacity>
                <TouchableOpacity
                  style={styles.sheetRow}
                  onPress={() => {
                    setAccountMenuOpen(false);
                    setLockSheetOpen(true);
                  }}
                >
                  <Text style={styles.sheetRowText}>
                    {lockStatus?.configured ? "App lock" : "Set up app lock"}
                  </Text>
                </TouchableOpacity>
                <TouchableOpacity
                  style={styles.sheetRow}
                  onPress={() => {
                    setAccountMenuOpen(false);
                    setRemindersOpen(true);
                  }}
                >
                  <Text style={styles.sheetRowText}>Reminders</Text>
                </TouchableOpacity>
                <TouchableOpacity
                  style={styles.sheetRow}
                  onPress={() => {
                    setAccountMenuOpen(false);
                    onSignOut();
                  }}
                >
                  <Text style={styles.sheetRowText}>Sign out</Text>
                </TouchableOpacity>

                <TouchableOpacity
                  style={styles.sheetDeleteLink}
                  hitSlop={{ top: 6, bottom: 6, left: 6, right: 6 }}
                  onPress={() => {
                    setAccountMenuOpen(false);
                    handleDeleteAccount();
                  }}
                >
                  <Text style={styles.sheetDeleteText}>Delete my account</Text>
                </TouchableOpacity>
              </TouchableOpacity>
            </TouchableOpacity>
          </Modal>

          <LockSetupSheet
            visible={lockSheetOpen}
            onClose={() => setLockSheetOpen(false)}
            configured={lockStatus?.configured ?? false}
            biometricEnabled={lockStatus?.biometric ?? false}
            identity={{
              userId: session.user.id,
              email: session.user.email ?? null,
              displayName: userName,
              role: isManager ? "manager" : "employee",
            }}
            onChanged={refreshLock}
          />

          <RemindersSheet
            visible={remindersOpen}
            onClose={() => setRemindersOpen(false)}
            isManager={isManager}
            support={reminderSupport}
            prefs={reminderPrefs}
            onSaved={onRemindersSaved}
          />

          {banner ? (
            <TouchableOpacity
              style={styles.bannerWrap}
              onPress={() => setBanner(null)}
              accessibilityRole="alert"
            >
              <Text style={styles.bannerText}>{banner}  (tap to dismiss)</Text>
            </TouchableOpacity>
          ) : null}

          {/* Guided tour — rendered inside the themed subtree so the spotlight
              card follows the on-shift palette. */}
          <TutorialOverlay />
        </SafeAreaView>
      </View>
    </ThemeContext.Provider>
  );
}

const makeStyles = (c: Palette) =>
  StyleSheet.create({
    container: { flex: 1, backgroundColor: c.bg },
    // The on-screen tree: PaletteBackdrop paints the background under a
    // transparent SafeAreaView.
    root: { flex: 1 },
    safe: { flex: 1 },
    main: { flex: 1 },
    center: { alignItems: "center", justifyContent: "center" },
    header: {
      flexDirection: "row",
      alignItems: "center",
      justifyContent: "space-between",
      paddingHorizontal: 24,
      paddingTop: 12,
      paddingBottom: 4,
    },
    avatarBtn: {
      width: 36,
      height: 36,
      borderRadius: 18,
      backgroundColor: c.accent,
      alignItems: "center",
      justifyContent: "center",
    },
    avatarInitial: { color: c.accentText, fontSize: 16, fontWeight: "700" },
    sheetBackdrop: {
      flex: 1,
      // Deliberately lighter than the shared scrim token: this sheet opens
      // over the dark on-shift screen, where 0.6 reads as a blackout.
      backgroundColor: "rgba(0,0,0,0.45)",
      justifyContent: "flex-end",
    },
    sheetCard: {
      backgroundColor: c.surface,
      borderTopLeftRadius: 20,
      borderTopRightRadius: 20,
      paddingHorizontal: 20,
      paddingTop: 20,
      paddingBottom: 36,
    },
    sheetName: { color: c.text, fontSize: 17, fontWeight: "700" },
    sheetSub: { color: c.textMuted, fontSize: 14, marginTop: 2 },
    sheetEmail: { color: c.textMuted, fontSize: 13, marginTop: 2 },
    sheetDivider: { height: 1, backgroundColor: c.border, marginVertical: 12 },
    sheetRow: { paddingVertical: 14 },
    sheetRowText: { color: c.text, fontSize: 16, fontWeight: "600" },
    sheetRowDanger: { color: c.danger, fontSize: 16, fontWeight: "600" },
    // Deliberately de-emphasized and set apart from Sign out so it can't be
    // mis-tapped when reaching for sign-out. It stays small and muted; the
    // destructive intent is confirmed in a two-step dialog, not by a big red row.
    sheetDeleteLink: {
      marginTop: 24,
      paddingVertical: 10,
      alignItems: "center",
    },
    sheetDeleteText: { color: c.textMuted, fontSize: 13, fontWeight: "500" },
    body: {
      flexGrow: 1,
      paddingHorizontal: 24,
      paddingTop: 8,
      paddingBottom: 24,
      justifyContent: "center",
    },
    greeting: { marginBottom: 16 },
    hello: { color: c.text, fontSize: 22, fontWeight: "700" },
    org: { color: c.textMuted, fontSize: 14, marginTop: 2 },
    statusCard: {
      borderRadius: 20,
      borderWidth: 1,
      paddingVertical: 32,
      paddingHorizontal: 16,
      alignItems: "center",
      marginBottom: 24,
    },
    statusCardOn: { backgroundColor: c.surfaceAlt, borderColor: c.accent },
    statusCardBreak: { backgroundColor: c.surfaceAlt, borderColor: c.warn },
    statusCardOff: { backgroundColor: c.surface, borderColor: c.border },
    statusLabel: {
      color: c.textMuted,
      fontSize: 14,
      fontWeight: "700",
      letterSpacing: 1.5,
      marginBottom: 12,
    },
    timer: {
      color: c.text,
      fontSize: 52,
      fontWeight: "800",
      fontVariant: ["tabular-nums"],
    },
    clockNow: {
      color: c.text,
      fontSize: 46,
      fontWeight: "800",
      fontVariant: ["tabular-nums"],
    },
    dateNow: { color: c.textMuted, fontSize: 16, marginTop: 8 },
    subMeta: {
      color: c.textMuted,
      fontSize: 14,
      fontWeight: "600",
      marginTop: 12,
    },
    // Text in the card's own text colour with a clay underline: clay text on
    // the dark card measured 2.94:1 (4.08:1 on the light card), and clay stays
    // the accent as the underline instead of the letters.
    adjustLinkLine: {
      marginTop: 14,
      borderBottomWidth: 1.5,
      borderBottomColor: c.accent,
    },
    adjustLink: {
      color: c.text,
      fontSize: 14,
      fontWeight: "600",
    },
    switchHint: {
      color: c.textMuted,
      fontSize: 13,
      marginTop: -4,
      marginBottom: 16,
    },
    note: {
      backgroundColor: c.surface,
      borderColor: c.border,
      borderWidth: 1,
      borderRadius: 14,
      paddingHorizontal: 16,
      paddingVertical: 14,
      color: c.text,
      fontSize: 16,
      marginBottom: 16,
    },
    bigButton: { borderRadius: 18, paddingVertical: 22, alignItems: "center" },
    inButton: { backgroundColor: c.accent },
    outButton: { backgroundColor: c.dangerFill },
    breakButton: {
      backgroundColor: c.surfaceAlt,
      borderWidth: 1,
      borderColor: c.border,
    },
    buttonStacked: { marginTop: 12 },
    landingRow: {
      flexDirection: "row",
      alignItems: "center",
      justifyContent: "center",
      gap: 10,
    },
    buttonDisabled: { opacity: 0.6 },
    bigButtonText: { fontSize: 22, fontWeight: "800" },
    requireHint: {
      color: c.warn,
      fontSize: 14,
      textAlign: "center",
      marginTop: 18,
      fontWeight: "600",
    },
    syncRow: {
      flexDirection: "row",
      alignItems: "center",
      justifyContent: "center",
      gap: 8,
      marginTop: 18,
    },
    syncDot: { width: 7, height: 7, borderRadius: 4 },
    pending: {
      color: c.warn,
      fontSize: 14,
      fontWeight: "600",
    },
    synced: {
      color: c.success,
      fontSize: 14,
      fontWeight: "600",
    },
    held: {
      color: c.warn,
      fontSize: 14,
      lineHeight: 20,
      textAlign: "center",
      marginTop: 12,
      fontWeight: "600",
    },
    history: { marginTop: 28 },
    historyTitle: {
      color: c.textMuted,
      fontSize: 13,
      fontWeight: "700",
      letterSpacing: 1,
      marginBottom: 8,
    },
    historyRow: {
      flexDirection: "row",
      alignItems: "center",
      paddingVertical: 12,
      borderTopWidth: 1,
      borderTopColor: c.border,
    },
    historyLeft: { flex: 1, paddingRight: 12 },
    historyDateRow: { flexDirection: "row", alignItems: "center", gap: 8 },
    historyDate: { color: c.text, fontSize: 15, fontWeight: "600" },
    historySub: { color: c.textMuted, fontSize: 13, marginTop: 2 },
    upcomingMore: { color: c.textMuted, fontSize: 13, marginTop: 8 },
    historyDur: { color: c.text, fontSize: 15, fontWeight: "700" },
    historyChevron: { color: c.textMuted, fontSize: 18, marginLeft: 8 },
    // A rejected shift: a red badge by the date, the manager's reason below, and
    // a struck-through duration — it is not worked time until the employee fixes
    // it. Tapping the row opens the correction request sheet.
    rejectedBadge: {
      backgroundColor: c.dangerFill,
      borderRadius: 6,
      paddingHorizontal: 6,
      paddingVertical: 1,
    },
    rejectedBadgeText: {
      color: c.accentText,
      fontSize: 10,
      fontWeight: "700",
      letterSpacing: 0.4,
    },
    rejectedReason: { color: c.danger, fontSize: 13, marginTop: 3 },
    historyDurRejected: {
      color: c.textMuted,
      textDecorationLine: "line-through",
    },
    offlineHint: {
      color: c.textMuted,
      fontSize: 13,
      textAlign: "center",
      marginTop: 20,
      lineHeight: 18,
    },
    bannerWrap: {
      backgroundColor: c.dangerFill,
      paddingVertical: 12,
      paddingHorizontal: 20,
    },
    bannerText: { color: c.accentText, fontSize: 14, textAlign: "center" },
    undoCard: {
      position: "absolute",
      left: 16,
      right: 16,
      bottom: 16,
      flexDirection: "row",
      alignItems: "center",
      gap: 12,
      paddingVertical: 11,
      paddingLeft: 14,
      paddingRight: 12,
      borderRadius: 12,
      borderWidth: 1,
      borderColor: lightColors.border,
      backgroundColor: lightColors.surface,
      shadowColor: "#0f0f0e",
      shadowOpacity: 0.3,
      shadowRadius: 18,
      shadowOffset: { width: 0, height: 10 },
      elevation: 8,
    },
    undoText: { flex: 1, color: lightColors.text, fontSize: 15 },
    undoCount: { color: lightColors.textMuted },
    undoButton: {
      minHeight: 44,
      justifyContent: "center",
      paddingHorizontal: 14,
      borderRadius: 8,
      borderWidth: 1,
      borderColor: lightColors.border,
      backgroundColor: lightColors.bg,
    },
    undoButtonText: {
      color: lightColors.text,
      fontSize: 15,
      fontWeight: "600",
    },
  });
