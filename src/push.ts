import Constants from "expo-constants";
import * as Device from "expo-device";
import * as Notifications from "expo-notifications";
import { Platform } from "react-native";

import { registerPushToken, unregisterPushToken } from "./api";
import { reportError } from "./error-reporting";
import { ensureReminderChannel } from "./reminder-notifications";
import { isLateShiftReminder } from "./reminders";

// Show notifications while the app is foregrounded too, except a shift
// reminder that arrives after its shift has started (Android 12 and later
// can deliver it late; reminders.ts isLateShiftReminder). In the background
// the phone shows it without asking the app.
Notifications.setNotificationHandler({
  handleNotification: async (notification) => {
    const show = !isLateShiftReminder(
      notification.request.content.data,
      Date.now(),
    );
    return {
      shouldShowBanner: show,
      shouldShowList: show,
      shouldPlaySound: show,
      shouldSetBadge: false,
    };
  },
});

function projectId(): string | undefined {
  // `eas init` writes this into app.json under extra.eas.projectId.
  const extra = Constants.expoConfig?.extra as
    | { eas?: { projectId?: string } }
    | undefined;
  return extra?.eas?.projectId;
}

/**
 * Push is unavailable when: running in a simulator, running in Expo Go (remote
 * push was removed from Expo Go in SDK 53+), or there's no EAS projectId yet
 * (no dev build). In all of these we skip silently so the app never breaks —
 * push starts working once you ship an EAS build.
 */
function unsupported(): boolean {
  return (
    !Device.isDevice || Constants.appOwnership === "expo" || !projectId()
  );
}

async function getDeviceToken(): Promise<string | null> {
  const pid = projectId();
  if (!pid) return null;
  try {
    const res = await Notifications.getExpoPushTokenAsync({ projectId: pid });
    return res.data;
  } catch (err) {
    reportError(err, "push.getDeviceToken");
    return null;
  }
}

async function ensureDefaultChannel(): Promise<void> {
  if (Platform.OS !== "android") return;
  await Notifications.setNotificationChannelAsync("default", {
    name: "Default",
    importance: Notifications.AndroidImportance.DEFAULT,
  });
}

/**
 * Ask permission (as the app always has at sign-in, so server pushes such as
 * "we clocked you out" reach new installs), get the Expo push token, and
 * register it with the API. Called on every signed-in launch so a token that
 * changed is registered again; the phone only shows the prompt while it
 * still allows asking. The Reminders screen asks again through
 * askForNotifications when someone turns a switch on after declining here.
 */
export async function registerForPush(accessToken: string): Promise<void> {
  try {
    if (unsupported()) return;

    const existing = await Notifications.getPermissionsAsync();
    let status = existing.status;
    if (status !== "granted" && existing.canAskAgain) {
      // Android 13 and later want a channel before the prompt.
      await ensureDefaultChannel();
      status = (await Notifications.requestPermissionsAsync()).status;
    }
    if (status !== "granted") return;

    await ensureDefaultChannel();

    const token = await getDeviceToken();
    if (token) await registerPushToken(accessToken, token, Platform.OS);
  } catch (err) {
    // Never break the app over push setup — but do report it so a silent
    // registration failure (permissions, network, Expo outage) is visible.
    reportError(err, "push.registerForPush");
  }
}

/** Remove this device's token (called on sign-out). */
export async function unregisterForPush(accessToken: string): Promise<void> {
  try {
    if (unsupported()) return;
    const token = await getDeviceToken();
    if (token) await unregisterPushToken(accessToken, token);
  } catch (err) {
    reportError(err, "push.unregisterForPush");
  }
}

export type NotificationAccess = {
  granted: boolean;
  /** False once the phone will not show the permission prompt again (iOS
   *  after one refusal, Android after two). Only Settings can change it. */
  canAskAgain: boolean;
};

/** Whether Clox may show notifications on this phone. Never asks. */
export async function getNotificationAccess(): Promise<NotificationAccess> {
  try {
    const p = await Notifications.getPermissionsAsync();
    return { granted: p.status === "granted", canAskAgain: p.canAskAgain };
  } catch (err) {
    reportError(err, "push.getNotificationAccess");
    return { granted: false, canAskAgain: false };
  }
}

/**
 * Ask for notification permission, when the phone still allows asking. The
 * Reminders screen calls this when a switch is turned on (the sign-in
 * launch asks too, in registerForPush). On Android the channels are created first, as Expo's
 * notes ask for Android 13 and later (creating a channel does not prompt by
 * itself for an app built for Android 13 or later). Once allowed, this
 * phone's push token is registered, so server pushes (the refused clock-in
 * alert, the "we clocked you out" message) can reach it. Works in Expo Go
 * too, where only the token step is skipped.
 */
export async function askForNotifications(
  accessToken: string | null,
): Promise<NotificationAccess> {
  try {
    const existing = await Notifications.getPermissionsAsync();
    if (existing.status === "granted") {
      return { granted: true, canAskAgain: existing.canAskAgain };
    }
    if (!existing.canAskAgain) return { granted: false, canAskAgain: false };
    await ensureDefaultChannel();
    await ensureReminderChannel();
    const res = await Notifications.requestPermissionsAsync();
    const granted = res.status === "granted";
    if (granted && accessToken) void registerForPush(accessToken);
    return { granted, canAskAgain: res.canAskAgain };
  } catch (err) {
    reportError(err, "push.askForNotifications");
    return getNotificationAccess();
  }
}
