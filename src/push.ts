import Constants from "expo-constants";
import * as Device from "expo-device";
import * as Notifications from "expo-notifications";
import { Platform } from "react-native";

import { registerPushToken, unregisterPushToken } from "./api";
import { reportError } from "./error-reporting";

// Show notifications while the app is foregrounded too.
Notifications.setNotificationHandler({
  handleNotification: async () => ({
    shouldShowBanner: true,
    shouldShowList: true,
    shouldPlaySound: true,
    shouldSetBadge: false,
  }),
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

/** Ask permission, get the Expo push token, and register it with the API. */
export async function registerForPush(accessToken: string): Promise<void> {
  try {
    if (unsupported()) return;

    const existing = await Notifications.getPermissionsAsync();
    let status = existing.status;
    if (status !== "granted") {
      status = (await Notifications.requestPermissionsAsync()).status;
    }
    if (status !== "granted") return;

    if (Platform.OS === "android") {
      await Notifications.setNotificationChannelAsync("default", {
        name: "Default",
        importance: Notifications.AndroidImportance.DEFAULT,
      });
    }

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
