import { useCallback, useEffect, useMemo, useState } from "react";
import {
  AccessibilityInfo,
  AppState,
  Linking,
  Modal,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Switch,
  Text,
  TouchableOpacity,
  View,
} from "react-native";

import { saveReminderPreferences } from "../api";
import { haptics } from "../lib/haptics";
import {
  askForNotifications,
  getNotificationAccess,
  type NotificationAccess,
} from "../push";
import {
  DEFAULT_LONG_SHIFT_HOURS,
  DEFAULT_SHIFT_REMINDER_MINUTES,
  isOn,
  parseReminderPrefs,
  prefsPatch,
  type ReminderField,
  type ReminderPrefs,
} from "../reminders";
import { getAccessToken } from "../supabase";
import { lightColors, type Palette } from "../theme";

/** Whether this phone knows the person's reminder preferences:
 *  "supported" (from the server, or the copy saved on this phone),
 *  "unsupported" (the server predates them), "unknown" (no answer yet and
 *  nothing saved). */
export type ReminderSupport = "unknown" | "unsupported" | "supported";

type Props = {
  visible: boolean;
  onClose: () => void;
  isManager: boolean;
  support: ReminderSupport;
  prefs: ReminderPrefs | null;
  /** The preferences as the server saved them. */
  onSaved: (prefs: ReminderPrefs) => void;
};

type Notice = { text: string; action: "settings" | "ask" | null };

const MONO = Platform.select({
  ios: "Menlo",
  android: "monospace",
  default: "monospace",
});

// The mockup's switch colors: moss when on (the nearest token), sand when
// off, a paper knob.
const TRACK_ON = lightColors.success;
const TRACK_OFF = "#cfc6b3";
const KNOB = "#fbf8f3";

const COPY = {
  unsupported:
    "Reminders aren't available yet. They start working with an upcoming Clox update, and you can turn them on here then.",
  unknown:
    "Clox couldn't load your reminder settings. Connect to the internet, then open this again.",
  deniedAfterAsk:
    "Notifications are off for Clox, so this reminder stays off. You can allow them for Clox in your phone's Settings.",
  offWhileOn:
    "Notifications are off for Clox on this phone, so the reminders you turned on can't show.",
  offWhileOnSettings:
    "Notifications are off for Clox on this phone, so the reminders you turned on can't show. You can allow them in your phone's Settings.",
  notLive:
    "Saving reminders isn't available yet. It starts working with an upcoming Clox update.",
  rateLimited: "Too many changes in a row. Wait a minute, then try again.",
  notManager: "Only managers can turn on this alert.",
  signIn:
    "Your sign-in has expired. Sign out and sign in again, then try again.",
  offline:
    "Clox couldn't reach the server. Check your connection and try again.",
  unknownError: "Clox couldn't save that. Try again in a moment.",
  offPhone:
    "These reminders are set on this phone. If your schedule changes, or you clock in or out somewhere else, a reminder can still arrive until you next open Clox.",
  // Android 12 and later deliver the reminder alarms late at times (the
  // 1.3.0 build has no exact alarms), sometimes after the shift has started.
  androidLate: "On Android it can sometimes arrive late.",
};

function saveErrorCopy(code: string): string {
  if (code === "http_404") return COPY.notLive;
  if (code === "rate_limited") return COPY.rateLimited;
  if (code === "not_manager") return COPY.notManager;
  if (code === "unauthorized" || code === "http_401") return COPY.signIn;
  return COPY.unknownError;
}

/**
 * The Reminders screen, opened from the account menu. Three switches, all
 * off until the person turns them on; the third is for managers. Turning one
 * on asks for notification permission first if it is not allowed yet, and
 * a refusal leaves the switch off with a sentence that says why. Each change
 * is saved to the server right away (POST profile/preferences), and the
 * screen shows what the server saved. The phone schedules the reminders
 * (ClockScreen, through reminder-notifications.ts); nothing here reads
 * location.
 */
export function RemindersSheet({
  visible,
  onClose,
  isManager,
  support,
  prefs,
  onSaved,
}: Props) {
  const c = lightColors;
  const styles = useMemo(() => makeStyles(c), [c]);

  const [access, setAccess] = useState<NotificationAccess | null>(null);
  const [saving, setSaving] = useState<{
    field: ReminderField;
    on: boolean;
  } | null>(null);
  const [notice, setNotice] = useState<Notice | null>(null);

  const readAccess = useCallback(() => {
    void getNotificationAccess().then(setAccess);
  }, []);

  // Fresh each time the sheet opens, and again when the person comes back
  // from Settings with the sheet still open.
  useEffect(() => {
    if (!visible) return;
    readAccess();
    const sub = AppState.addEventListener("change", (s) => {
      if (s === "active") readAccess();
    });
    return () => sub.remove();
  }, [visible, readAccess]);

  const usable = support === "supported" && prefs !== null;

  // The last tap's notice belongs to that visit; closing clears it.
  const close = useCallback(() => {
    setNotice(null);
    onClose();
  }, [onClose]);

  const toggle = useCallback(
    async (field: ReminderField, on: boolean) => {
      if (saving || !usable) return;
      setNotice(null);
      const token = await getAccessToken();
      if (on) {
        const got = await askForNotifications(token);
        setAccess(got);
        if (!got.granted) {
          // The copy points to Settings, so the button to get there always
          // comes with it (Android 13 and later can still ask once more after
          // a first refusal, and turning the switch on again does that).
          setNotice({ text: COPY.deniedAfterAsk, action: "settings" });
          return;
        }
      }
      if (!token) {
        setNotice({ text: COPY.signIn, action: null });
        return;
      }
      setSaving({ field, on });
      try {
        const res = await saveReminderPreferences(token, prefsPatch(field, on));
        if (res.ok) {
          const saved = parseReminderPrefs(res.data.preferences);
          if (saved) {
            haptics.light();
            onSaved(saved);
          } else {
            setNotice({ text: COPY.unknownError, action: null });
          }
        } else {
          setNotice({ text: saveErrorCopy(res.error), action: null });
        }
      } catch {
        setNotice({ text: COPY.offline, action: null });
      } finally {
        setSaving(null);
      }
    },
    [saving, usable, onSaved],
  );

  // What a tap led to is spoken. The notice sits above the rows, away from
  // the switch just toggled, and accessibilityLiveRegion is Android only.
  // `queue` waits for VoiceOver's current speech (the switch's new value).
  useEffect(() => {
    if (notice) {
      AccessibilityInfo.announceForAccessibilityWithOptions(notice.text, {
        queue: true,
      });
    }
  }, [notice]);

  const askAgain = useCallback(async () => {
    const token = await getAccessToken();
    const got = await askForNotifications(token);
    setAccess(got);
  }, []);

  const minutes = prefs?.shiftReminderMinutes ?? DEFAULT_SHIFT_REMINDER_MINUTES;
  const hours = prefs?.longShiftHours ?? DEFAULT_LONG_SHIFT_HOURS;
  const rows: { field: ReminderField; label: string; sub: string }[] = [
    {
      field: "shiftReminderMinutes",
      label: "Before a scheduled shift",
      sub:
        `Your phone reminds you about ${minutes} minutes before a shift on your schedule starts.` +
        (Platform.OS === "android" ? ` ${COPY.androidLate}` : ""),
    },
    {
      field: "longShiftHours",
      label: `When a shift passes ${hours} hours`,
      sub: `Your phone reminds you once you have been clocked in for ${hours} hours, in case you forgot to clock out.`,
    },
  ];
  if (isManager) {
    rows.push({
      field: "notifyRefusedPunch",
      label: "When a punch is refused",
      sub: "You get a push when an employee's clock-in from the app is refused because they aren't at the job site. Only managers get this one.",
    });
  }

  const anyOn =
    usable && rows.some((r) => isOn(prefs, r.field));
  // A standing notice: the server can't save yet, nothing is known, or a
  // reminder is on while this phone can't show notifications. A notice from
  // the last tap takes its place.
  const standing: Notice | null =
    support === "unsupported"
      ? { text: COPY.unsupported, action: null }
      : !usable
        ? { text: COPY.unknown, action: null }
        : anyOn && access && !access.granted
          ? access.canAskAgain
            ? { text: COPY.offWhileOn, action: "ask" }
            : { text: COPY.offWhileOnSettings, action: "settings" }
          : null;
  const shown = notice ?? standing;

  return (
    <Modal
      visible={visible}
      transparent
      animationType="slide"
      onRequestClose={close}
    >
      <View style={styles.scrim}>
        {/* The scrim closes the sheet. It sits behind the card rather than
            around it, so the card's scrolling is never a press on it. */}
        <Pressable
          style={StyleSheet.absoluteFill}
          onPress={close}
          accessibilityRole="button"
          accessibilityLabel="Close reminders"
        />
        <View style={styles.card}>
          <View style={styles.handle} />
          <ScrollView
            bounces={false}
            contentContainerStyle={styles.scrollBody}
          >
            <Text style={styles.eyebrow}>SETTINGS · REMINDERS</Text>
            <Text style={styles.title} accessibilityRole="header">
              Reminders are nudges, not tracking.
            </Text>
            <Text style={styles.intro}>
              Each one is off until you turn it on. None of them reads your
              location.
            </Text>

            {shown ? (
              <View
                style={styles.notice}
                // A tap's notice is announced above; the live region covers
                // the standing ones on Android without saying a tap's twice.
                accessibilityLiveRegion={notice ? "none" : "polite"}
              >
                <Text style={styles.noticeText}>{shown.text}</Text>
                {shown.action === "settings" ? (
                  <TouchableOpacity
                    onPress={() => void Linking.openSettings()}
                    accessibilityRole="button"
                    hitSlop={8}
                  >
                    <Text style={styles.noticeAction}>Open Settings</Text>
                  </TouchableOpacity>
                ) : shown.action === "ask" ? (
                  <TouchableOpacity
                    onPress={() => void askAgain()}
                    accessibilityRole="button"
                    hitSlop={8}
                  >
                    <Text style={styles.noticeAction}>Allow notifications</Text>
                  </TouchableOpacity>
                ) : null}
              </View>
            ) : null}

            <View style={styles.rows}>
              {rows.map((r, i) => {
                const pending = saving?.field === r.field ? saving : null;
                const value = pending ? pending.on : isOn(prefs, r.field);
                return (
                  <View
                    key={r.field}
                    style={[styles.row, i > 0 && styles.rowDivider]}
                  >
                    <View style={styles.rowText}>
                      <Text style={styles.rowLabel}>{r.label}</Text>
                      <Text style={styles.rowSub}>{r.sub}</Text>
                    </View>
                    <Switch
                      value={usable ? value : false}
                      onValueChange={(next) => void toggle(r.field, next)}
                      disabled={!usable || saving !== null}
                      trackColor={{ true: TRACK_ON, false: TRACK_OFF }}
                      ios_backgroundColor={TRACK_OFF}
                      thumbColor={KNOB}
                      accessibilityLabel={r.label}
                      accessibilityHint={r.sub}
                    />
                  </View>
                );
              })}
            </View>

            {usable ? (
              <Text style={styles.footnote}>{COPY.offPhone}</Text>
            ) : null}

            <TouchableOpacity
              style={styles.done}
              onPress={close}
              accessibilityRole="button"
            >
              <Text style={styles.doneText}>Done</Text>
            </TouchableOpacity>
          </ScrollView>
        </View>
      </View>
    </Modal>
  );
}

const makeStyles = (c: Palette) =>
  StyleSheet.create({
    scrim: {
      flex: 1,
      backgroundColor: "rgba(0,0,0,0.45)",
      justifyContent: "flex-end",
    },
    card: {
      backgroundColor: c.bg,
      borderTopLeftRadius: 24,
      borderTopRightRadius: 24,
      paddingTop: 10,
      maxHeight: "90%",
    },
    handle: {
      alignSelf: "center",
      width: 36,
      height: 4,
      borderRadius: 2,
      backgroundColor: TRACK_OFF,
      marginBottom: 14,
    },
    scrollBody: { paddingHorizontal: 22, paddingBottom: 36 },
    eyebrow: {
      fontFamily: MONO,
      fontSize: 10.5,
      fontWeight: "600",
      letterSpacing: 1.5,
      color: c.textMuted,
    },
    title: {
      color: c.text,
      fontSize: 18,
      fontWeight: "700",
      marginTop: 6,
    },
    intro: {
      color: c.textMuted,
      fontSize: 12.5,
      lineHeight: 18,
      marginTop: 4,
    },
    notice: {
      marginTop: 14,
      padding: 12,
      borderRadius: 12,
      backgroundColor: c.surfaceAlt,
    },
    noticeText: { color: c.text, fontSize: 13, lineHeight: 19 },
    noticeAction: {
      color: c.accent,
      fontSize: 14,
      fontWeight: "700",
      marginTop: 8,
    },
    rows: {
      marginTop: 16,
      borderTopWidth: 1,
      borderTopColor: c.border,
    },
    row: {
      minHeight: 52,
      flexDirection: "row",
      alignItems: "center",
      paddingVertical: 12,
      gap: 12,
    },
    rowDivider: { borderTopWidth: 1, borderTopColor: "#ece6da" },
    rowText: { flex: 1 },
    rowLabel: { color: c.text, fontSize: 14, fontWeight: "600" },
    rowSub: {
      color: c.textMuted,
      fontSize: 12,
      lineHeight: 17,
      marginTop: 2,
    },
    footnote: {
      color: c.textMuted,
      fontSize: 12,
      lineHeight: 17,
      marginTop: 14,
    },
    done: { paddingVertical: 14, alignItems: "center", marginTop: 8 },
    doneText: { color: c.textMuted, fontSize: 15, fontWeight: "600" },
  });
