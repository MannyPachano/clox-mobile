import { useMemo, useState } from "react";
import {
  FlatList,
  Modal,
  Pressable,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from "react-native";

import type { Option } from "../api";
import { useColors, type Palette, scrim, radii } from "../theme";

type Props = {
  label: string;
  value: string | null;
  options: Option[];
  placeholder: string;
  onSelect: (id: string | null) => void;
  disabled?: boolean;
  /** When set, adds a "clear" row at the top (e.g. "No project"). Omit to force
   *  a real choice (used when a project is required). */
  noneLabel?: string;
};

/**
 * A tap-to-open selector: a field row showing the current choice, and a modal
 * sheet listing the options. Follows the active theme via `useColors`.
 */
export function SelectField({
  label,
  value,
  options,
  placeholder,
  onSelect,
  disabled,
  noneLabel,
}: Props) {
  const c = useColors();
  const styles = useMemo(() => makeStyles(c), [c]);
  const [open, setOpen] = useState(false);
  const selected = options.find((o) => o.id === value) ?? null;
  // Empty-string id is the sentinel for the "none" row.
  const rows: Option[] = noneLabel
    ? [{ id: "", name: noneLabel }, ...options]
    : options;

  return (
    <View style={styles.wrap}>
      <Text style={styles.label}>{label}</Text>
      <TouchableOpacity
        style={[styles.field, disabled && styles.fieldDisabled]}
        onPress={() => !disabled && setOpen(true)}
        activeOpacity={0.8}
        disabled={disabled}
      >
        <Text
          style={[styles.value, !selected && styles.placeholder]}
          numberOfLines={1}
        >
          {selected ? selected.name : placeholder}
        </Text>
        <Text style={styles.chevron}>▾</Text>
      </TouchableOpacity>

      <Modal
        visible={open}
        transparent
        animationType="fade"
        onRequestClose={() => setOpen(false)}
      >
        <Pressable style={styles.backdrop} onPress={() => setOpen(false)}>
          {/* Empty onPress captures taps so they don't dismiss the sheet. */}
          <Pressable style={styles.sheet} onPress={() => {}}>
            <Text style={styles.sheetTitle}>{label}</Text>
            <FlatList
              data={rows}
              keyExtractor={(item) => item.id || "__none"}
              style={styles.list}
              renderItem={({ item }) => {
                const isSelected = (item.id || null) === value;
                return (
                  <TouchableOpacity
                    style={styles.option}
                    onPress={() => {
                      onSelect(item.id ? item.id : null);
                      setOpen(false);
                    }}
                  >
                    <Text
                      style={[
                        styles.optionText,
                        isSelected && styles.optionSelected,
                      ]}
                      numberOfLines={1}
                    >
                      {item.name}
                    </Text>
                    {isSelected ? <Text style={styles.check}>✓</Text> : null}
                  </TouchableOpacity>
                );
              }}
              ListEmptyComponent={
                <Text style={styles.empty}>Nothing to choose from.</Text>
              }
            />
          </Pressable>
        </Pressable>
      </Modal>
    </View>
  );
}

const makeStyles = (c: Palette) =>
  StyleSheet.create({
    wrap: { marginBottom: 14 },
    label: {
      color: c.textMuted,
      fontSize: 13,
      fontWeight: "600",
      marginBottom: 6,
    },
    field: {
      backgroundColor: c.surface,
      borderColor: c.border,
      borderWidth: 1,
      borderRadius: 14,
      paddingHorizontal: 16,
      paddingVertical: 16,
      flexDirection: "row",
      alignItems: "center",
    },
    fieldDisabled: { opacity: 0.5 },
    value: { flex: 1, color: c.text, fontSize: 16 },
    placeholder: { color: c.textMuted },
    chevron: { color: c.textMuted, fontSize: 14, marginLeft: 8 },
    backdrop: {
      flex: 1,
      backgroundColor: scrim,
      justifyContent: "flex-end",
    },
    sheet: {
      backgroundColor: c.surface,
      borderTopLeftRadius: 20,
      borderTopRightRadius: 20,
      paddingTop: 16,
      paddingBottom: 28,
      maxHeight: "70%",
    },
    sheetTitle: {
      color: c.text,
      fontSize: 18,
      fontWeight: "700",
      paddingHorizontal: 20,
      marginBottom: 8,
    },
    list: { paddingHorizontal: 8 },
    option: {
      flexDirection: "row",
      alignItems: "center",
      paddingHorizontal: 16,
      paddingVertical: 16,
      borderRadius: radii.md,
    },
    optionText: { flex: 1, color: c.text, fontSize: 17 },
    optionSelected: { color: c.accent, fontWeight: "700" },
    check: { color: c.accent, fontSize: 18, fontWeight: "800" },
    empty: {
      color: c.textMuted,
      fontSize: 15,
      textAlign: "center",
      paddingVertical: 24,
    },
  });
