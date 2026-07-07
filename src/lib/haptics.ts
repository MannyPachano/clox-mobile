import * as Haptics from "expo-haptics";

/**
 * Thin, safe wrapper around expo-haptics.
 *
 * Every call is fire-and-forget and swallows errors: haptics are a nicety, not
 * a dependency of any flow, so a device without a haptic engine (or a transient
 * failure) must never surface or block. iOS has a full Taptic Engine; Android
 * maps these to its vibration patterns where available.
 */
function run(p: Promise<void>): void {
  void p.catch(() => {});
}

export type HapticKind =
  | "tap"
  | "light"
  | "medium"
  | "heavy"
  | "success"
  | "warning"
  | "error";

export const haptics = {
  /** A light selection tick — the default for an ordinary button press. */
  tap: () => run(Haptics.selectionAsync()),
  light: () => run(Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light)),
  /** A firm tap for primary actions (clock in / clock out). */
  medium: () => run(Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium)),
  heavy: () => run(Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Heavy)),
  /** Positive outcome — an approval or a confirmed action. */
  success: () =>
    run(Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success)),
  /** Caution — a rejection or a reversible warning. */
  warning: () =>
    run(Haptics.notificationAsync(Haptics.NotificationFeedbackType.Warning)),
  /** Failure — a blocked action or an error. */
  error: () =>
    run(Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error)),
};
