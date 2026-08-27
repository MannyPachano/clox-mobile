import { useEffect, useMemo, useState } from "react";
import {
  Modal,
  StyleSheet,
  Switch,
  Text,
  TouchableOpacity,
  View,
} from "react-native";

import { PinPad } from "./PinPad";
import {
  biometricLabel,
  isBiometricAvailable,
  type BiometricKind,
} from "../lib/biometrics";
import { haptics } from "../lib/haptics";
import {
  clearLock,
  PIN_LENGTH,
  setBiometricEnabled,
  setupLock,
  type LockIdentity,
} from "../lib/app-lock";
import { lightColors, type Palette } from "../theme";

type Props = {
  visible: boolean;
  onClose: () => void;
  identity: LockIdentity | null;
  /** Whether a lock already exists (manage mode) vs first-time setup. */
  configured: boolean;
  biometricEnabled: boolean;
  /** Called after any change so the host can refresh lock status. */
  onChanged: () => void;
};

type Step = "manage" | "create" | "confirm" | "biometric";

/**
 * Set up, change, or remove the offline app lock. Reachable from the account
 * menu. Only usable while signed in (identity is required), because the PIN is
 * bound to the current account. Managing biometrics never re-prompts for the
 * PIN; changing or removing the PIN is done by turning the lock off and on.
 */
export function LockSetupSheet({
  visible,
  onClose,
  identity,
  configured,
  biometricEnabled,
  onChanged,
}: Props) {
  const c = lightColors;
  const styles = useMemo(() => makeStyles(c), [c]);

  const [step, setStep] = useState<Step>(configured ? "manage" : "create");
  const [firstPin, setFirstPin] = useState("");
  const [pin, setPin] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [bioKind, setBioKind] = useState<BiometricKind>("none");
  const [bioReady, setBioReady] = useState(false);

  // Reset to the right entry step each time the sheet opens.
  useEffect(() => {
    if (visible) {
      setStep(configured ? "manage" : "create");
      setFirstPin("");
      setPin("");
      setError(null);
    }
  }, [visible, configured]);

  useEffect(() => {
    void isBiometricAvailable().then((b) => {
      setBioKind(b.kind);
      setBioReady(b.available);
    });
  }, []);

  const finalize = async (biometric: boolean) => {
    if (!identity) return;
    await setupLock({ pin: firstPin, biometric, identity });
    haptics.success();
    onChanged();
    onClose();
  };

  const onCreateComplete = (entered: string) => {
    setFirstPin(entered);
    setPin("");
    setStep("confirm");
  };

  const onConfirmComplete = async (entered: string) => {
    if (entered !== firstPin) {
      haptics.error();
      setError("Those didn't match. Try again.");
      setFirstPin("");
      setPin("");
      setStep("create");
      return;
    }
    if (bioReady) {
      setStep("biometric");
    } else {
      await finalize(false);
    }
  };

  const turnOff = async () => {
    await clearLock();
    haptics.success();
    onChanged();
    onClose();
  };

  const toggleBiometric = async (on: boolean) => {
    await setBiometricEnabled(on);
    onChanged();
  };

  return (
    <Modal visible={visible} transparent animationType="slide" onRequestClose={onClose}>
      <TouchableOpacity style={styles.scrim} activeOpacity={1} onPress={onClose}>
        <TouchableOpacity activeOpacity={1} style={styles.card}>
          {step === "manage" ? (
            <View>
              <Text style={styles.title}>App lock is on</Text>
              <Text style={styles.body}>
                Clox asks for your PIN
                {biometricEnabled ? ` or ${biometricLabel(bioKind)}` : ""} when
                you open it, so you can clock in even with no signal.
              </Text>

              {bioReady ? (
                <View style={styles.row}>
                  <Text style={styles.rowLabel}>
                    Unlock with {biometricLabel(bioKind)}
                  </Text>
                  <Switch
                    value={biometricEnabled}
                    onValueChange={toggleBiometric}
                    trackColor={{ true: c.accent, false: c.border }}
                    thumbColor={c.surface}
                  />
                </View>
              ) : null}

              <TouchableOpacity style={styles.danger} onPress={turnOff}>
                <Text style={styles.dangerText}>Turn off app lock</Text>
              </TouchableOpacity>
              <TouchableOpacity style={styles.cancel} onPress={onClose}>
                <Text style={styles.cancelText}>Done</Text>
              </TouchableOpacity>
            </View>
          ) : step === "biometric" ? (
            <View style={styles.center}>
              <Text style={styles.title}>Use {biometricLabel(bioKind)}?</Text>
              <Text style={styles.body}>
                Unlock Clox with {biometricLabel(bioKind)} instead of typing your
                PIN each time. Your PIN still works as a backup.
              </Text>
              <TouchableOpacity
                style={styles.primary}
                onPress={() => finalize(true)}
              >
                <Text style={styles.primaryText}>
                  Enable {biometricLabel(bioKind)}
                </Text>
              </TouchableOpacity>
              <TouchableOpacity
                style={styles.cancel}
                onPress={() => finalize(false)}
              >
                <Text style={styles.cancelText}>Not now, PIN only</Text>
              </TouchableOpacity>
            </View>
          ) : (
            <View style={styles.center}>
              <Text style={styles.title}>
                {step === "create" ? "Set a lock PIN" : "Confirm your PIN"}
              </Text>
              <Text style={styles.body}>
                {step === "create"
                  ? `Choose a ${PIN_LENGTH}-digit PIN. You'll use it to open Clox offline.`
                  : "Enter it once more."}
              </Text>
              <View style={styles.pad}>
                <PinPad
                  value={pin}
                  onChange={(next) => {
                    if (error) setError(null);
                    setPin(next);
                    if (next.length === PIN_LENGTH) {
                      if (step === "create") onCreateComplete(next);
                      else void onConfirmComplete(next);
                    }
                  }}
                  length={PIN_LENGTH}
                  palette={c}
                />
              </View>
              {error ? <Text style={styles.error}>{error}</Text> : null}
              <TouchableOpacity style={styles.cancel} onPress={onClose}>
                <Text style={styles.cancelText}>Cancel</Text>
              </TouchableOpacity>
            </View>
          )}
        </TouchableOpacity>
      </TouchableOpacity>
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
      paddingHorizontal: 24,
      paddingTop: 24,
      paddingBottom: 40,
    },
    center: { alignItems: "center" },
    title: {
      color: c.text,
      fontSize: 20,
      fontWeight: "700",
      textAlign: "center",
    },
    body: {
      color: c.textMuted,
      fontSize: 15,
      textAlign: "center",
      marginTop: 8,
      marginBottom: 16,
      maxWidth: 320,
    },
    pad: { marginVertical: 12 },
    row: {
      flexDirection: "row",
      alignItems: "center",
      justifyContent: "space-between",
      paddingVertical: 14,
      borderTopWidth: 1,
      borderTopColor: c.border,
      marginTop: 8,
    },
    rowLabel: { color: c.text, fontSize: 16 },
    primary: {
      backgroundColor: c.accent,
      borderRadius: 14,
      paddingVertical: 16,
      alignItems: "center",
      alignSelf: "stretch",
      marginTop: 8,
    },
    primaryText: { color: c.accentText, fontSize: 17, fontWeight: "700" },
    danger: {
      paddingVertical: 16,
      alignItems: "center",
      marginTop: 8,
    },
    dangerText: { color: c.danger, fontSize: 16, fontWeight: "600" },
    cancel: { paddingVertical: 14, alignItems: "center" },
    cancelText: { color: c.textMuted, fontSize: 15 },
    error: {
      color: c.danger,
      fontSize: 14,
      textAlign: "center",
      marginTop: 4,
    },
  });
