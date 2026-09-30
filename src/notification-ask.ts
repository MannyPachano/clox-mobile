import AsyncStorage from "@react-native-async-storage/async-storage";
import * as Notifications from "expo-notifications";
import { Alert, Linking, Platform } from "react-native";

import { reportError } from "./error-reporting";
import { askForNotifications } from "./push";
import { hasNativeShiftSurface, SHIFT_SURFACES_ENABLED } from "./shift-surface";
import { planNotificationAsk, SURFACE_APP_COPY } from "./shift-surface-state";

/**
 * Decision 4, Android only: at a clock-in, someone who declined notifications
 * at sign-in is asked once more, with one plain sentence about why (the
 * running shift and its Clock out button on the lock screen need them). Never
 * more than once per install, never on iOS (a Live Activity needs no
 * notification permission), and never on a build without the 1.4.0 native
 * module, where the notification could not show anyway.
 *
 * The system prompt cannot be worded, so Clox's own question comes first.
 * Allow goes on to the system prompt (push.ts askForNotifications, which also
 * creates the channels and registers the push token). A phone that will not
 * show the system prompt again gets Open Settings instead.
 */

/** Set at the first clock-in that stands on 1.4.0: when the question shows,
 *  or when notifications are already allowed then (the one chance is spent,
 *  so someone who turns them off later is not asked). It stays through
 *  sign-out, so nobody is asked twice. */
export const NOTIFICATION_ASK_KEY = "clox.surface.notification-ask.v1";

export type NotificationAskResult =
  /** Notifications are allowed now. The running-shift notification can post. */
  | "allowed"
  /** Asked, and the person said Not now or declined the system prompt. */
  | "declined"
  /** Asked, and Settings opened. The next state push after they come back
   *  posts the notification if they allowed it there. */
  | "settings"
  /** Not asked: not Android, already allowed, asked before, or unsure. */
  | "not_asked";

let asking = false;

function askQuestion(primary: string): Promise<boolean> {
  return new Promise((resolve) => {
    Alert.alert(
      SURFACE_APP_COPY.askTitle,
      SURFACE_APP_COPY.askMessage,
      [
        {
          text: SURFACE_APP_COPY.askNotNow,
          style: "cancel",
          onPress: () => resolve(false),
        },
        { text: primary, onPress: () => resolve(true) },
      ],
      // Android: a tap outside the dialog, or Back, is Not now.
      { cancelable: true, onDismiss: () => resolve(false) },
    );
  });
}

/**
 * Ask once, if this phone should be asked. Call it when a clock-in stands
 * (the undo offer closed by itself), not while the undo offer is up.
 * `getToken` is read only after Allow.
 */
export async function askForLockScreenOnce(
  getToken: () => Promise<string | null>,
): Promise<NotificationAskResult> {
  if (Platform.OS !== "android" || asking) return "not_asked";
  if (!hasNativeShiftSurface()) return "not_asked";
  asking = true;
  try {
    let askedBefore: boolean;
    try {
      askedBefore = (await AsyncStorage.getItem(NOTIFICATION_ASK_KEY)) !== null;
    } catch {
      // Storage that cannot be read could hide an earlier ask. Not asking is
      // the side that never asks twice.
      return "not_asked";
    }
    // Read here rather than through push.ts getNotificationAccess, which
    // reads an error as "denied, cannot ask again": that would spend the one
    // ask on an Open Settings question for someone who may already allow
    // notifications. An error is unsure, and unsure never asks.
    let access: { granted: boolean; canAskAgain: boolean };
    try {
      const p = await Notifications.getPermissionsAsync();
      access = { granted: p.status === "granted", canAskAgain: p.canAskAgain };
    } catch {
      return "not_asked";
    }
    if (!askedBefore && access.granted) {
      // Allowed at the first clock-in: nothing to ask, and the chance is
      // spent (decision 4 asks only people who declined at sign-in).
      try {
        await AsyncStorage.setItem(NOTIFICATION_ASK_KEY, "1");
      } catch {
        // Unsaved: a later clock-in may ask once, if they turn them off.
      }
      return "not_asked";
    }
    const plan = planNotificationAsk({
      platform: Platform.OS,
      enabled: SHIFT_SURFACES_ENABLED,
      granted: access.granted,
      canAskAgain: access.canAskAgain,
      askedBefore,
    });
    if (plan === "none") return "not_asked";
    // Saved before the question shows, so a crash or a kill while it is up
    // still counts as the one time.
    try {
      await AsyncStorage.setItem(NOTIFICATION_ASK_KEY, "1");
    } catch {
      return "not_asked";
    }
    const primary =
      plan === "ask" ? SURFACE_APP_COPY.askAllow : SURFACE_APP_COPY.askSettings;
    const yes = await askQuestion(primary);
    if (!yes) return "declined";
    if (plan === "settings") {
      await Linking.openSettings();
      return "settings";
    }
    // The token registers this phone for pushes once allowed.
    const res = await askForNotifications(await getToken());
    return res.granted ? "allowed" : "declined";
  } catch (err) {
    reportError(err, "notification-ask.askForLockScreenOnce");
    return "not_asked";
  } finally {
    asking = false;
  }
}
