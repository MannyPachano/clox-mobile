import { useMemo } from "react";
import { StyleSheet, Text, TouchableOpacity, View } from "react-native";

import { haptics } from "../lib/haptics";
import type { Palette } from "../theme";

/**
 * A numeric PIN pad with a filled-dots indicator. Controlled: the parent owns
 * the entered string and decides when it's complete (length === pinLength).
 * Purely presentational — no knowledge of what the PIN is for.
 */
export function PinPad({
  value,
  onChange,
  length,
  palette,
  disabled = false,
}: {
  value: string;
  onChange: (next: string) => void;
  length: number;
  palette: Palette;
  disabled?: boolean;
}) {
  const c = palette;
  const styles = useMemo(() => makeStyles(c), [c]);

  const press = (digit: string) => {
    if (disabled || value.length >= length) return;
    haptics.tap();
    onChange(value + digit);
  };
  const backspace = () => {
    if (disabled || value.length === 0) return;
    haptics.tap();
    onChange(value.slice(0, -1));
  };

  const keys = ["1", "2", "3", "4", "5", "6", "7", "8", "9"];

  return (
    <View style={styles.wrap}>
      <View style={styles.dots} accessibilityLabel={`${value.length} of ${length} digits entered`}>
        {Array.from({ length }, (_, i) => (
          <View
            key={i}
            style={[styles.dot, i < value.length && styles.dotFilled]}
          />
        ))}
      </View>

      <View style={styles.grid}>
        {keys.map((k) => (
          <TouchableOpacity
            key={k}
            style={[styles.key, disabled && styles.keyDisabled]}
            onPress={() => press(k)}
            disabled={disabled}
            activeOpacity={0.6}
            accessibilityLabel={k}
          >
            <Text style={styles.keyText}>{k}</Text>
          </TouchableOpacity>
        ))}
        {/* bottom row: blank, 0, delete */}
        <View style={styles.key} />
        <TouchableOpacity
          style={[styles.key, disabled && styles.keyDisabled]}
          onPress={() => press("0")}
          disabled={disabled}
          activeOpacity={0.6}
          accessibilityLabel="0"
        >
          <Text style={styles.keyText}>0</Text>
        </TouchableOpacity>
        <TouchableOpacity
          style={styles.key}
          onPress={backspace}
          disabled={disabled || value.length === 0}
          activeOpacity={0.6}
          accessibilityLabel="Delete"
        >
          <Text style={styles.keyDelete}>⌫</Text>
        </TouchableOpacity>
      </View>
    </View>
  );
}

const makeStyles = (c: Palette) =>
  StyleSheet.create({
    wrap: { alignItems: "center" },
    dots: { flexDirection: "row", gap: 16, marginBottom: 36 },
    dot: {
      width: 14,
      height: 14,
      borderRadius: 7,
      borderWidth: 1.5,
      borderColor: c.textMuted,
    },
    dotFilled: { backgroundColor: c.accent, borderColor: c.accent },
    grid: {
      width: 280,
      flexDirection: "row",
      flexWrap: "wrap",
      justifyContent: "space-between",
      rowGap: 18,
    },
    key: {
      width: 76,
      height: 76,
      borderRadius: 38,
      alignItems: "center",
      justifyContent: "center",
      backgroundColor: c.surface,
      borderWidth: 1,
      borderColor: c.border,
    },
    keyDisabled: { opacity: 0.4 },
    keyText: { fontSize: 30, fontWeight: "500", color: c.text },
    keyDelete: { fontSize: 24, color: c.textMuted },
  });
