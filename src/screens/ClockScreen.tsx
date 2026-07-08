import { useCallback, useEffect, useMemo, useState } from "react";
import {
  ActivityIndicator,
  Alert,
  AppState,
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
  type HistoryShift,
  type MyScheduledShift,
  type Option,
} from "../api";
import { precheckGeofence, type Fence } from "../geofence";
import { haptics } from "../lib/haptics";
import { SelectField } from "../components/SelectField";
import { SelfieCapture } from "../components/SelfieCapture";
import { EditEntryModal } from "../components/EditEntryModal";
import { RequestEditModal } from "../components/RequestEditModal";
import { Wordmark } from "../components/Wordmark";
import { getPunchLocation } from "../location";
import {
  drainQueue,
  enqueuePunch,
  queuedCount,
  type PunchKind,
  type QueuedPunch,
} from "../queue";
import { getAccessToken } from "../supabase";
import {
  darkColors,
  normalizeThemePreference,
  resolvePalette,
  ThemeContext,
  type Palette,
  type ThemePreference,
} from "../theme";
import { useTutorial, useTutorialTarget } from "../tutorial/TutorialContext";
import { TutorialOverlay } from "../tutorial/TutorialOverlay";
import { newUuid } from "../uuid";

const DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const MONTHS = [
  "Jan", "Feb", "Mar", "Apr", "May", "Jun",
  "Jul", "Aug", "Sep", "Oct", "Nov", "Dec",
];

function formatElapsed(ms: number): string {
  const total = Math.floor((ms > 0 ? ms : 0) / 1000);
  const pad = (n: number) => n.toString().padStart(2, "0");
  return `${pad(Math.floor(total / 3600))}:${pad(
    Math.floor((total % 3600) / 60),
  )}:${pad(total % 60)}`;
}

function formatClock(ms: number): string {
  const d = new Date(ms);
  if (Number.isNaN(d.getTime())) return "—:—";
  let h = d.getHours();
  const m = d.getMinutes();
  const ampm = h >= 12 ? "PM" : "AM";
  h = h % 12 || 12;
  return `${h}:${m.toString().padStart(2, "0")} ${ampm}`;
}

function formatDate(ms: number): string {
  const d = new Date(ms);
  if (Number.isNaN(d.getTime())) return "—";
  return `${DAYS[d.getDay()]}, ${MONTHS[d.getMonth()]} ${d.getDate()}`;
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
};

export function ClockScreen({
  session,
  onSignOut,
  isManager = false,
}: Props) {
  const [userName, setUserName] = useState(session.user.email ?? "Employee");
  const [orgName, setOrgName] = useState("");
  const [shiftStartedAt, setShiftStartedAt] = useState<string | null>(null);
  const [onBreakSince, setOnBreakSince] = useState<string | null>(null);
  const [pending, setPending] = useState(0);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState("");
  const [banner, setBanner] = useState<string | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const [ready, setReady] = useState(false);

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
  // Worksite fences for the client-side clock-in pre-check. Empty = no geofence.
  const [fences, setFences] = useState<Fence[]>([]);

  const refresh = useCallback(async () => {
    const token = await getAccessToken();
    if (!token) return;
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
        setFences(d.geofence?.worksites ?? []);
        // Apply server truth only when the queue is empty — otherwise an
        // in-flight optimistic punch would be clobbered. (Also how a rejected
        // clock-in reverts: punch dropped → queue empty → server says "no
        // active shift" → optimistic timer clears.)
        if ((await queuedCount()) === 0) {
          const active = d.activeEntry;
          setShiftStartedAt(active?.startedAt ?? null);
          setOnBreakSince(d.onBreakSince);
          setProjectId(active ? active.projectId : null);
          setTaskId(active ? active.taskId : null);
        }
      }
      if (historyRes.ok) setHistory(historyRes.data.shifts);
      if (scheduleRes.ok) setUpcoming(scheduleRes.data.shifts);
    } catch {
      // Offline — keep optimistic local state.
    } finally {
      setReady(true);
    }
  }, []);

  const sync = useCallback(async () => {
    const token = await getAccessToken();
    if (!token) return;
    const result = await drainQueue(token);
    setPending(result.remaining);
    if (result.errors.length > 0) setBanner(result.errors[0] ?? null);
    await refresh();
  }, [refresh]);

  useEffect(() => {
    void refresh();
    void sync();
  }, [refresh, sync]);

  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, []);

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

  const enqueueSimple = useCallback(
    async (kind: PunchKind) => {
      const punch: QueuedPunch = {
        id: newUuid(),
        kind,
        clientTime: new Date().toISOString(),
        projectId: kind === "out" ? projectId : null,
        taskId: null,
        note: null,
        selfie: null,
        latitude: null,
        longitude: null,
        accuracyM: null,
        mocked: null,
      };
      try {
        await enqueuePunch(punch);
      } catch {
        setBanner(
          "Couldn't save that — check your phone's storage and try again.",
        );
        return;
      }
      setPending(await queuedCount());
      await sync();
    },
    [projectId, sync],
  );

  const enqueueSwitch = useCallback(
    async (nextProjectId: string | null, nextTaskId: string | null) => {
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
      };
      try {
        await enqueuePunch(punch);
      } catch {
        setBanner("Couldn't save the project switch — try again.");
        return;
      }
      setPending(await queuedCount());
      await sync();
    },
    [sync],
  );

  const onProjectChange = useCallback(
    (id: string | null) => {
      setProjectId(id);
      setTaskId(null);
      if (shiftStartedAt) void enqueueSwitch(id, null);
    },
    [shiftStartedAt, enqueueSwitch],
  );

  const onTaskChange = useCallback(
    (id: string | null) => {
      setTaskId(id);
      if (shiftStartedAt) void enqueueSwitch(projectId, id);
    },
    [shiftStartedAt, projectId, enqueueSwitch],
  );

  const doClockIn = useCallback(
    async (selfie: string | null) => {
      setBusy(true);
      setBanner(null);
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
        await enqueuePunch(punch);
      } catch {
        setBusy(false);
        setBanner(
          "Couldn't save your clock-in — check storage and try again.",
        );
        return;
      }
      setShiftStartedAt(punch.clientTime);
      setOnBreakSince(null);
      setNote("");
      setPending(await queuedCount());
      await sync();
      setBusy(false);
    },
    [projectId, taskId, note, sync, fences],
  );

  const onClockIn = useCallback(() => {
    haptics.medium();
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
    setShiftStartedAt(null);
    setOnBreakSince(null);
    await enqueueSimple("out");
    setBusy(false);
  }, [enqueueSimple]);

  const onBreakStart = useCallback(async () => {
    haptics.light();
    setBusy(true);
    setBanner(null);
    setOnBreakSince(new Date().toISOString());
    await enqueueSimple("break_start");
    setBusy(false);
  }, [enqueueSimple]);

  const onBreakEnd = useCallback(async () => {
    haptics.light();
    setBusy(true);
    setBanner(null);
    setOnBreakSince(null);
    await enqueueSimple("break_end");
    setBusy(false);
  }, [enqueueSimple]);

  // Guided-tour anchors (measured by the spotlight overlay) + replay trigger.
  const clockInRef = useTutorialTarget("clockIn");
  const projectRef = useTutorialTarget("project");
  const historyRef = useTutorialTarget("history");
  const { start: startTutorial } = useTutorial();

  const clockedIn = shiftStartedAt !== null;
  const palette = resolvePalette(themePreference, clockedIn);
  const isDark = palette === darkColors;
  const styles = useMemo(() => makeStyles(palette), [palette]);

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

  const onBreak = onBreakSince !== null;
  const elapsed = shiftStartedAt ? now - Date.parse(shiftStartedAt) : 0;
  const breakElapsed = onBreakSince ? now - Date.parse(onBreakSince) : 0;
  const tasksForProject = projectId ? tasksByProject[projectId] ?? [] : [];
  const projectMissing = !clockedIn && requireProject && !projectId;
  const showPickers = !onBreak;


  return (
    <ThemeContext.Provider value={palette}>
      <SafeAreaView style={styles.container} edges={["top", "bottom"]}>
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
                <Text style={styles.clockNow}>{formatClock(now)}</Text>
                <Text style={styles.dateNow}>{formatDate(now)}</Text>
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
                  Changing the project switches your current shift.
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
                  (busy || projectMissing) && styles.buttonDisabled,
                ]}
                onPress={onClockIn}
                disabled={busy || projectMissing}
                activeOpacity={0.85}
              >
                {busy ? (
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
                  busy && styles.buttonDisabled,
                ]}
                onPress={onBreak ? onBreakEnd : onBreakStart}
                disabled={busy}
                activeOpacity={0.85}
              >
                <Text style={[styles.bigButtonText, { color: palette.text }]}>
                  {onBreak ? "End break" : "Take break"}
                </Text>
              </TouchableOpacity>
              <TouchableOpacity
                style={[
                  styles.bigButton,
                  styles.outButton,
                  styles.buttonStacked,
                  busy && styles.buttonDisabled,
                ]}
                onPress={onClockOut}
                disabled={busy}
                activeOpacity={0.85}
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
            </>
          )}

          {projectMissing ? (
            <Text style={styles.requireHint}>
              {projects.length === 0
                ? "Your organization requires a project to clock in, but none have been set up yet. Ask your manager to add a project on the Clox website."
                : "Pick a project to clock in."}
            </Text>
          ) : pending > 0 ? (
            <Text style={styles.pending}>
              {pending} {pending === 1 ? "punch" : "punches"} waiting to sync
            </Text>
          ) : (
            <Text style={styles.synced}>All punches synced</Text>
          )}

          {upcoming.length > 0 ? (
            <View style={styles.history}>
              <Text style={styles.historyTitle}>Upcoming shifts</Text>
              {upcoming.slice(0, 3).map((s) => (
                <View key={s.id} style={styles.historyRow}>
                  <View style={styles.historyLeft}>
                    <Text style={styles.historyDate}>
                      {formatDate(Date.parse(s.startsAt))}
                    </Text>
                    <Text style={styles.historySub} numberOfLines={1}>
                      {formatClock(Date.parse(s.startsAt))} –{" "}
                      {formatClock(Date.parse(s.endsAt))}
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
                    <Text style={styles.historyDate}>
                      {formatDate(Date.parse(s.start))}
                    </Text>
                    <Text style={styles.historySub} numberOfLines={1}>
                      {formatClock(Date.parse(s.start))} –{" "}
                      {formatClock(Date.parse(s.end))}
                      {s.project ? ` · ${s.project}` : ""}
                    </Text>
                  </View>
                  <Text style={styles.historyDur}>
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

        <SelfieCapture
          visible={cameraOpen}
          onCancel={() => setCameraOpen(false)}
          onUse={onSelfieUse}
        />

        <EditEntryModal
          visible={editShift !== null}
          entry={
            editShift
              ? {
                  id: editShift.id,
                  start: editShift.start,
                  end: editShift.end,
                  projectId: editShift.projectId,
                  note: editShift.note,
                }
              : null
          }
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

        {banner ? (
          <TouchableOpacity
            style={styles.bannerWrap}
            onPress={() => setBanner(null)}
          >
            <Text style={styles.bannerText}>{banner}  (tap to dismiss)</Text>
          </TouchableOpacity>
        ) : null}

        {/* Guided tour — rendered inside the themed subtree so the spotlight
            card follows the on-shift palette. */}
        <TutorialOverlay />
      </SafeAreaView>
    </ThemeContext.Provider>
  );
}

const makeStyles = (c: Palette) =>
  StyleSheet.create({
    container: { flex: 1, backgroundColor: c.bg },
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
    outButton: { backgroundColor: c.danger },
    breakButton: {
      backgroundColor: c.surfaceAlt,
      borderWidth: 1,
      borderColor: c.border,
    },
    buttonStacked: { marginTop: 12 },
    buttonDisabled: { opacity: 0.6 },
    bigButtonText: { fontSize: 22, fontWeight: "800" },
    requireHint: {
      color: c.warn,
      fontSize: 14,
      textAlign: "center",
      marginTop: 18,
      fontWeight: "600",
    },
    pending: {
      color: c.warn,
      fontSize: 14,
      textAlign: "center",
      marginTop: 18,
      fontWeight: "600",
    },
    synced: {
      color: c.success,
      fontSize: 14,
      textAlign: "center",
      marginTop: 18,
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
    historyDate: { color: c.text, fontSize: 15, fontWeight: "600" },
    historySub: { color: c.textMuted, fontSize: 13, marginTop: 2 },
    upcomingMore: { color: c.textMuted, fontSize: 13, marginTop: 8 },
    historyDur: { color: c.text, fontSize: 15, fontWeight: "700" },
    historyChevron: { color: c.textMuted, fontSize: 18, marginLeft: 8 },
    offlineHint: {
      color: c.textMuted,
      fontSize: 13,
      textAlign: "center",
      marginTop: 20,
      lineHeight: 18,
    },
    bannerWrap: {
      backgroundColor: c.danger,
      paddingVertical: 12,
      paddingHorizontal: 20,
    },
    bannerText: { color: "#fff", fontSize: 14, textAlign: "center" },
  });
