import { useMemo } from "react";
import {
  Modal,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from "react-native";

import { useColors, type Palette, scrim } from "../theme";

export type DetailRow = { label: string; value: string };

/**
 * A bottom sheet showing the full, untruncated detail of a tapped item
 * (used for a recent shift). Generic title + label/value rows; follows the
 * active theme. Tap the backdrop or Done to close.
 */
export function ShiftDetailSheet({
  visible,
  title,
  rows,
  onClose,
}: {
  visible: boolean;
  title: string;
  rows: DetailRow[];
  onClose: () => void;
}) {
  const c = useColors();
  const styles = useMemo(() => makeStyles(c), [c]);

  return (
    <Modal
      visible={visible}
      transparent
      animationType="slide"
      onRequestClose={onClose}
    >
      <Pressable style={styles.backdrop} onPress={onClose}>
        {/* Empty onPress captures taps so they don't dismiss the sheet. */}
        <Pressable style={styles.sheet} onPress={() => {}}>
          <Text style={styles.title}>{title}</Text>
          <ScrollView style={styles.list}>
            {rows.map((r) => (
              <View key={r.label} style={styles.row}>
                <Text style={styles.label}>{r.label}</Text>
                <Text style={styles.value}>{r.value}</Text>
              </View>
            ))}
          </ScrollView>
          <Pressable style={styles.done} onPress={onClose}>
            <Text style={styles.doneText}>Done</Text>
          </Pressable>
        </Pressable>
      </Pressable>
    </Modal>
  );
}

const makeStyles = (c: Palette) =>
  StyleSheet.create({
    backdrop: {
      flex: 1,
      backgroundColor: scrim,
      justifyContent: "flex-end",
    },
    sheet: {
      backgroundColor: c.surface,
      borderTopLeftRadius: 20,
      borderTopRightRadius: 20,
      paddingTop: 18,
      paddingBottom: 28,
      maxHeight: "80%",
    },
    title: {
      color: c.text,
      fontSize: 18,
      fontWeight: "700",
      paddingHorizontal: 20,
      marginBottom: 4,
    },
    list: { paddingHorizontal: 20 },
    row: {
      paddingVertical: 12,
      borderTopWidth: 1,
      borderTopColor: c.border,
    },
    label: {
      color: c.textMuted,
      fontSize: 12,
      fontWeight: "700",
      letterSpacing: 1,
      textTransform: "uppercase",
      marginBottom: 4,
    },
    value: { color: c.text, fontSize: 16, lineHeight: 22 },
    done: {
      marginHorizontal: 20,
      marginTop: 16,
      backgroundColor: c.surfaceAlt,
      borderWidth: 1,
      borderColor: c.border,
      borderRadius: 14,
      paddingVertical: 14,
      alignItems: "center",
    },
    doneText: { color: c.text, fontSize: 16, fontWeight: "700" },
  });
