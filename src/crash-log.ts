import AsyncStorage from "@react-native-async-storage/async-storage";
import { Alert, Share } from "react-native";
import * as Updates from "expo-updates";

import { reportError } from "./error-reporting";

// TEMPORARY diagnostic (2026-10-07). The 2FA code step crashed on an iPhone
// with a fatal JavaScript error that never reached /client-error: the app is
// gone before that request goes out. expo-updates catches such a crash, rolls
// the update back and writes the error to its own log file on the phone,
// which outlives the crash. This reads that log once at launch and, when a
// crash was recorded in the last day, shows it with a way to share the full
// text. Remove it once the code step is fixed.

const LOOKBACK_MS = 24 * 60 * 60 * 1000;
const SHOWN_KEY = "clox.crash-log.shown.v1";

export async function showLastCrashOnce(): Promise<void> {
  try {
    const entries = await Updates.readLogEntriesAsync(LOOKBACK_MS);
    const crashes = entries.filter(
      (e) =>
        String(e.code) === "JSRuntimeError" ||
        /fatal|exception|ErrorRecovery/i.test(e.message),
    );
    const last = crashes[crashes.length - 1];
    if (!last) return;
    if ((await AsyncStorage.getItem(SHOWN_KEY)) === String(last.timestamp)) {
      return;
    }
    await AsyncStorage.setItem(SHOWN_KEY, String(last.timestamp));
    const text = crashes
      .map((e) =>
        [
          `${new Date(e.timestamp).toISOString()} ${String(e.level)} ${String(e.code)} update=${e.updateId ?? "-"}`,
          e.message,
          ...(e.stacktrace ?? []),
        ].join("\n"),
      )
      .join("\n\n");
    reportError(new Error(text.slice(0, 1000)), "updates-crash-log");
    Alert.alert("Clox closed unexpectedly", last.message.slice(0, 500), [
      {
        text: "Share details",
        onPress: () => void Share.share({ message: text }).catch(() => {}),
      },
      { text: "OK" },
    ]);
  } catch {
    // Diagnostics must never break the app.
  }
}
