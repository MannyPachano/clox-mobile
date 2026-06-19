import { useCallback, useEffect, useMemo, useState } from "react";
import {
  ActivityIndicator,
  Alert,
  AppState,
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
  getStatus,
  type HistoryShift,
  type Option,
} from "../api";
import { SelectField } from "../components/SelectField";
import { SelfieCapture } from "../components/SelfieCapture";
import { ShiftDetailSheet } from "../components/ShiftDetailSheet";
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
};

export function ClockScreen({ session, onSignOut }: Props) {
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
  const [selectedShift, setSelectedShift] = useState<HistoryShift | null>(null);

  const refresh = useCallback(async () => {
    const token = await getAccessToken();
    if (!token) return;
    try {
      const [statusRes, historyRes] = await Promise.all([
        getStatus(token),
        getHistory(token),
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
    [projectId, taskId, note, sync],
  );

  const onClockIn = useCallback(() => {
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
    setBusy(true);
    setBanner(null);
    setShiftStartedAt(null);
    setOnBreakSince(null);
    await enqueueSimple("out");
    setBusy(false);
  }, [enqueueSimple]);

  const onBreakStart = useCallback(async () => {
    setBusy(true);
    setBanner(null);
    setOnBreakSince(new Date().toISOString());
    await enqueueSimple("break_start");
    setBusy(false);
  }, [enqueueSimple]);

  const onBreakEnd = useCallback(async () => {
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
    Alert.alert(
      "Delete account",
      "This permanently deletes your account and personal details. Your past " +
        "time entries stay with your employer for payroll but can no longer be " +
        "tied to you. This can't be undone.",
      [
        { text: "Cancel", style: "cancel" },
        {
          text: "Delete account",
          style: "destructive",
          onPress: () => {
            void (async () => {
              const token = await getAccessToken();
              if (!token) {
                Alert.alert(
                  "Sign in required",
                  "Please sign in again and retry.",
                );
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

  const detailRows = selectedShift
    ? [
        {
          label: "Time",
          value: `${formatClock(Date.parse(selectedShift.start))} – ${formatClock(
            Date.parse(selectedShift.end),
          )}`,
        },
        { label: "Duration", value: formatDuration(selectedShift.durationMs) },
        { label: "Project", value: selectedShift.project ?? "No project" },
        ...(selectedShift.task
          ? [{ label: "Task", value: selectedShift.task }]
          : []),
        ...(selectedShift.note
          ? [{ label: "Note", value: selectedShift.note }]
          : []),
      ]
    : [];

  return (
    <ThemeContext.Provider value={palette}>
      <SafeAreaView style={styles.container} edges={["top", "bottom"]}>
        <StatusBar style={isDark ? "light" : "dark"} />
        <View style={styles.header}>
          <Wordmark palette={palette} size={22} />
          <View style={styles.headerActions}>
            <TouchableOpacity onPress={startTutorial} hitSlop={12}>
              <Text style={styles.signOut}>Tutorial</Text>
            </TouchableOpacity>
            <TouchableOpacity onPress={onSignOut} hitSlop={12}>
              <Text style={styles.signOut}>Sign out</Text>
            </TouchableOpacity>
          </View>
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
            <Text style={styles.requireHint}>Pick a project to clock in.</Text>
          ) : pending > 0 ? (
            <Text style={styles.pending}>
              {pending} {pending === 1 ? "punch" : "punches"} waiting to sync
            </Text>
          ) : (
            <Text style={styles.synced}>All punches synced</Text>
          )}

          {history.length > 0 ? (
            <View ref={historyRef} style={styles.history}>
              <Text style={styles.historyTitle}>Recent shifts</Text>
              {history.map((s) => (
                <TouchableOpacity
                  key={s.id}
                  style={styles.historyRow}
                  onPress={() => setSelectedShift(s)}
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
            Works offline — your punch is saved on this phone and syncs
            automatically when you&apos;re back online.
          </Text>

          <TouchableOpacity
            onPress={handleDeleteAccount}
            hitSlop={8}
            style={styles.deleteAccountWrap}
          >
            <Text style={styles.deleteAccount}>Delete account</Text>
          </TouchableOpacity>
        </ScrollView>

        <SelfieCapture
          visible={cameraOpen}
          onCancel={() => setCameraOpen(false)}
          onUse={onSelfieUse}
        />

        <ShiftDetailSheet
          visible={selectedShift !== null}
          title={
            selectedShift ? formatDate(Date.parse(selectedShift.start)) : ""
          }
          rows={detailRows}
          onClose={() => setSelectedShift(null)}
        />

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
    headerActions: { flexDirection: "row", alignItems: "center", gap: 18 },
    signOut: { color: c.textMuted, fontSize: 15, fontWeight: "600" },
    deleteAccountWrap: { alignSelf: "center", marginTop: 28, paddingVertical: 8 },
    deleteAccount: { color: c.danger, fontSize: 14, fontWeight: "600" },
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
