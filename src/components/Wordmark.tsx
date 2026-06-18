import { Text } from "react-native";

import type { Palette } from "../theme";

/**
 * The Clox wordmark: "Clox" with a clay accent dot. Pure text (no asset) so it
 * scales crisply and recolors with the active theme. Pass the active palette.
 */
export function Wordmark({
  palette,
  size = 26,
}: {
  palette: Palette;
  size?: number;
}) {
  return (
    <Text
      style={{
        fontSize: size,
        fontWeight: "800",
        letterSpacing: 0.5,
        color: palette.text,
      }}
      accessibilityRole="header"
    >
      Clox<Text style={{ color: palette.accent }}>.</Text>
    </Text>
  );
}
