import { useEffect, useState } from "react";
import { Animated, Easing, StyleSheet, View } from "react-native";

import { paletteFlipMs } from "../clock-moment";
import { darkColors, lightColors } from "../theme";

/**
 * The screen background, cross-faded between the two palettes. The paper
 * layer sits underneath and the ink layer fades over it on the native driver,
 * so going on shift darkens the screen over PALETTE_FLIP_MS instead of
 * snapping, and clocking out lightens it the same way. Text and cards take
 * the new palette at once and read against the background as it turns.
 *
 * Render it as the first child of a container with no background of its own.
 * The first render shows the palette as it is, with no fade; so does a
 * change while Reduce Motion is on.
 */
export function PaletteBackdrop({
  dark,
  reduceMotion,
}: {
  dark: boolean;
  reduceMotion: boolean;
}) {
  const [ink] = useState(() => new Animated.Value(dark ? 1 : 0));

  useEffect(() => {
    const duration = paletteFlipMs(reduceMotion);
    if (duration === 0) {
      ink.setValue(dark ? 1 : 0);
      return;
    }
    const anim = Animated.timing(ink, {
      toValue: dark ? 1 : 0,
      duration,
      easing: Easing.bezier(0.2, 0.7, 0.2, 1),
      useNativeDriver: true,
    });
    anim.start();
    return () => anim.stop();
  }, [dark, reduceMotion, ink]);

  return (
    <View pointerEvents="none" style={StyleSheet.absoluteFill}>
      <View style={[StyleSheet.absoluteFill, styles.paper]} />
      <Animated.View
        style={[StyleSheet.absoluteFill, styles.ink, { opacity: ink }]}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  paper: { backgroundColor: lightColors.bg },
  ink: { backgroundColor: darkColors.bg },
});
