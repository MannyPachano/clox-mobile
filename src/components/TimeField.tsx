import { useState } from "react";
import { Platform, Pressable, StyleSheet, Text, View } from "react-native";
import DateTimePicker, {
  type DateTimePickerEvent,
} from "@react-native-community/datetimepicker";

import { lightColors as c } from "../theme";

function fmt(d: Date): string {
  let h = d.getHours();
  const m = d.getMinutes();
  const ap = h >= 12 ? "PM" : "AM";
  h = h % 12 || 12;
  return `${h}:${m.toString().padStart(2, "0")} ${ap}`;
}

/**
 * An exact-minute time field, so a manager can set the real clocked time (e.g.
 * 7:03) instead of snapping to a 15-minute step. iOS shows a compact chip that
 * opens its own auto-dismissing popover; Android opens the native time dialog on
 * tap. The hook is declared unconditionally (before the platform branch) to
 * stay within the Rules of Hooks.
 */
export function TimeField({
  label,
  value,
  onChange,
}: {
  label: string;
  value: Date;
  onChange: (d: Date) => void;
}) {
  const [open, setOpen] = useState(false);

  if (Platform.OS === "ios") {
    return (
      <View style={styles.row}>
        <Text style={styles.label}>{label}</Text>
        <DateTimePicker
          value={value}
          mode="time"
          minuteInterval={1}
          display="compact"
          themeVariant="light"
          onChange={(_event, picked) => {
            if (picked) onChange(picked);
          }}
        />
      </View>
    );
  }

  function handleAndroid(event: DateTimePickerEvent, picked?: Date) {
    setOpen(false);
    if (event.type === "set" && picked) onChange(picked);
  }

  return (
    <View style={styles.wrap}>
      <Text style={styles.label}>{label}</Text>
      <Pressable style={styles.field} onPress={() => setOpen(true)}>
        <Text style={styles.value}>{fmt(value)}</Text>
      </Pressable>
      {open ? (
        <DateTimePicker
          value={value}
          mode="time"
          is24Hour={false}
          minuteInterval={1}
          display="default"
          onChange={handleAndroid}
        />
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: { marginBottom: 12 },
  row: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    marginBottom: 12,
  },
  label: {
    color: c.textMuted,
    fontSize: 12,
    fontWeight: "700",
    letterSpacing: 1,
    textTransform: "uppercase",
    marginBottom: 6,
  },
  field: {
    backgroundColor: c.surface,
    borderColor: c.border,
    borderWidth: 1,
    borderRadius: 14,
    paddingHorizontal: 16,
    paddingVertical: 14,
  },
  value: { color: c.text, fontSize: 16 },
});
