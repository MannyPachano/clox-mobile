import AsyncStorage from "@react-native-async-storage/async-storage";
import * as Notifications from "expo-notifications";
import { Platform } from "react-native";

import { reportError } from "./error-reporting";
import {
  LONG_SHIFT_ID_PREFIX,
  parsePrefsCache,
  planLongShiftReminder,
  planShiftReminders,
  REMINDER_CHANNEL_ID,
  REMINDER_ID_PREFIX,
  serializePrefsCache,
  type ReminderPlan,
  type ReminderPrefs,
  type ScheduledShift,
  type WallClock,
} from "./reminders";

/**
 * Carries out the plans in reminders.ts with expo-notifications, and keeps
 * the last known reminder preferences on disk.
 *
 * Everything the 1.3.0 store build already has: expo-notifications 0.32
 * schedules local notifications with a date trigger, lists and cancels them
 * by identifier, and creates Android channels at runtime. Nothing here needs
 * a native change, so it ships as an EAS Update.
 *
 * Calls run one at a time (each reads the scheduled list, then cancels and
 * schedules), so two syncs never interleave and undo each other. A sync only
 * runs while this phone is armed for the user it was made for: ClockScreen
 * arms on mount, and sign-out (cancelAllReminders) disarms before it
 * cancels, so a refresh that lands after sign-out schedules nothing.
 */

const PREFS_KEY = "clox.reminder-prefs.v1";

let armedFor: string | null = null;

export function armReminders(userId: string): void {
  armedFor = userId;
}

/** ClockScreen unmounts (sign-out, or the app lock covering it). Scheduled
 *  reminders stay; they belong to the phone, not the screen. */
export function disarmReminders(userId: string): void {
  if (armedFor === userId) armedFor = null;
}

let chain: Promise<void> = Promise.resolve();

function serial(task: () => Promise<void>, where: string): Promise<void> {
  const run = chain.then(task).catch((err: unknown) => {
    reportError(err, where);
  });
  chain = run;
  return run;
}

let channelReady: Promise<void> | null = null;

/** The Android channel local reminders post to. A trigger naming a channel
 *  that does not exist never shows, so this runs before any schedule. Its
 *  importance is fixed once created (Android lets only the person change
 *  it), so it is set once, here. */
export function ensureReminderChannel(): Promise<void> {
  if (Platform.OS !== "android") return Promise.resolve();
  if (!channelReady) {
    channelReady = Notifications.setNotificationChannelAsync(
      REMINDER_CHANNEL_ID,
      {
        name: "Reminders",
        description:
          "Clox reminds you before a scheduled shift and when a shift runs long, if you turn those on.",
        importance: Notifications.AndroidImportance.HIGH,
      },
    ).then(
      () => undefined,
      (err: unknown) => {
        channelReady = null;
        throw err;
      },
    );
  }
  return channelReady;
}

async function allowed(): Promise<boolean> {
  const p = await Notifications.getPermissionsAsync();
  return p.status === "granted";
}

async function scheduledIds(): Promise<string[]> {
  const all = await Notifications.getAllScheduledNotificationsAsync();
  return all.map((r) => r.identifier);
}

async function apply(plan: ReminderPlan): Promise<void> {
  for (const id of plan.cancel) {
    await Notifications.cancelScheduledNotificationAsync(id);
  }
  if (plan.schedule.length === 0) return;
  await ensureReminderChannel();
  for (const r of plan.schedule) {
    await Notifications.scheduleNotificationAsync({
      identifier: r.identifier,
      content: {
        title: r.title,
        body: r.body,
        data: r.data,
        sound: true,
      },
      trigger: {
        type: Notifications.SchedulableTriggerInputTypes.DATE,
        date: r.fireAtMs,
        channelId: REMINDER_CHANNEL_ID,
      },
    });
  }
}

/**
 * Bring the shift start reminders in line with the schedule. `minutes`
 * undefined: the preference is not known yet. `shifts` null: no schedule
 * has loaded this session. `wallClock` null: the org zone is not known.
 * Partial knowledge never schedules anything (planShiftReminders).
 * Without notification permission nothing new is scheduled either, since it
 * could not show.
 */
export function syncShiftReminders(
  userId: string,
  input: {
    minutes: number | null | undefined;
    shifts: ScheduledShift[] | null;
    runningSinceMs: number | null;
    wallClock: ((ms: number) => WallClock | null) | null;
  },
): Promise<void> {
  return serial(async () => {
    if (armedFor !== userId) return;
    const ids = await scheduledIds();
    const plan = planShiftReminders({
      ...input,
      scheduledIds: ids,
      nowMs: Date.now(),
    });
    if (plan.schedule.length > 0 && !(await allowed())) plan.schedule = [];
    await apply(plan);
  }, "reminders.syncShift");
}

/** Bring the long shift reminder in line with the running shift. `hours`
 *  undefined: the preference is not known yet. */
export function syncLongShiftReminder(
  userId: string,
  input: {
    hours: number | null | undefined;
    runningSinceMs: number | null;
    isManager: boolean;
  },
): Promise<void> {
  return serial(async () => {
    if (armedFor !== userId) return;
    const ids = await scheduledIds();
    const plan = planLongShiftReminder({
      ...input,
      scheduledIds: ids,
      nowMs: Date.now(),
    });
    if (plan.schedule.length > 0 && !(await allowed())) plan.schedule = [];
    await apply(plan);
  }, "reminders.syncLong");
}

/**
 * Cancel the long shift reminder ("Still on the clock?") without the Clock
 * screen. A clock-out from the Lock Screen, the widget or the Android
 * notification can be handled while the Clock screen is not mounted (the
 * app lock is up, the app was started in the background for the tap, or a
 * manager is on another tab), and then nothing is armed to run
 * syncLongShiftReminder. The shift is over either way, so this needs
 * neither the preferences nor arming. It runs in the same line as every
 * other sync, after any sync already queued, so that one cannot put the
 * reminder back afterwards.
 * The shift start reminders held while on the clock come back at the Clock
 * screen's next refresh.
 */
export function cancelLongShiftReminders(): Promise<void> {
  return serial(async () => {
    const ids = await scheduledIds();
    for (const id of ids) {
      if (id.startsWith(LONG_SHIFT_ID_PREFIX)) {
        await Notifications.cancelScheduledNotificationAsync(id);
      }
    }
  }, "reminders.cancelLong");
}

/** Sign-out and re-authentication: disarm, then cancel every reminder this
 *  app scheduled. Runs after any sync already queued, so nothing survives. */
export function cancelAllReminders(): Promise<void> {
  armedFor = null;
  return serial(async () => {
    const ids = await scheduledIds();
    for (const id of ids) {
      if (id.startsWith(REMINDER_ID_PREFIX)) {
        await Notifications.cancelScheduledNotificationAsync(id);
      }
    }
  }, "reminders.cancelAll");
}

// ── Last known preferences, per user ───────────────────────────────────────
// A clock-in right after a cold start with no signal still needs to know
// whether the long shift reminder is on. Same owner guard as fence-cache.ts:
// a read only returns the entry of the user who wrote it.

export async function readReminderPrefsCache(
  userId: string,
): Promise<ReminderPrefs | null> {
  try {
    return parsePrefsCache(await AsyncStorage.getItem(PREFS_KEY), userId);
  } catch {
    return null;
  }
}

export async function writeReminderPrefsCache(
  userId: string,
  prefs: ReminderPrefs,
): Promise<void> {
  try {
    await AsyncStorage.setItem(PREFS_KEY, serializePrefsCache(userId, prefs));
  } catch {
    // A failed write only costs an offline cold start its reminder choices.
  }
}

export async function clearReminderPrefsCache(): Promise<void> {
  try {
    await AsyncStorage.removeItem(PREFS_KEY);
  } catch {
    // ignore
  }
}
