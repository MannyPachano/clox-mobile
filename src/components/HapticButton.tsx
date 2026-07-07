import {
  TouchableOpacity,
  type TouchableOpacityProps,
  type GestureResponderEvent,
} from "react-native";

import { haptics, type HapticKind } from "../lib/haptics";

/**
 * Drop-in replacement for TouchableOpacity that fires a haptic on press.
 * Defaults to a light selection tap; pass `haptic` to change the feel for a
 * primary confirm ("medium"/"success") or a destructive action ("warning").
 * All TouchableOpacity props pass through unchanged.
 */
export function HapticButton({
  haptic = "tap",
  onPress,
  ...rest
}: TouchableOpacityProps & { haptic?: HapticKind }) {
  return (
    <TouchableOpacity
      onPress={(e: GestureResponderEvent) => {
        haptics[haptic]();
        onPress?.(e);
      }}
      {...rest}
    />
  );
}
