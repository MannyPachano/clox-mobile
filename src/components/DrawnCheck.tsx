import { useEffect, useState } from "react";
import { Animated, Easing, StyleSheet, View } from "react-native";

import { CHECK_DRAW_MS } from "../clock-moment";

// The check is an "L" (a short bar and a long bar) turned 45 degrees, the
// same shape as the mockup's path M4 12.5l5 5L20 6.5 in a 20 point box.
// Each bar grows from the end where the stroke starts, so it draws like a
// pen: the short bar down to the corner first, then the long bar up.
const BOX = 20;
const STROKE = 3;
const SHORT = 7;
const LONG = 14;
/** Share of the draw spent on the short bar (its share of the length). */
const SPLIT = SHORT / (SHORT + LONG);
/** A scale of exactly zero is a singular transform on some devices. */
const MIN_SCALE = 0.01;

/**
 * A check mark that draws itself in CHECK_DRAW_MS on mount, on the native
 * driver (transforms only). With `animate` false it appears already drawn,
 * for Reduce Motion.
 */
export function DrawnCheck({
  color,
  animate,
}: {
  color: string;
  animate: boolean;
}) {
  const [progress] = useState(() => new Animated.Value(animate ? 0 : 1));

  useEffect(() => {
    if (!animate) {
      progress.setValue(1);
      return;
    }
    const anim = Animated.timing(progress, {
      toValue: 1,
      duration: CHECK_DRAW_MS,
      easing: Easing.bezier(0.2, 0.7, 0.2, 1),
      useNativeDriver: true,
    });
    anim.start();
    return () => anim.stop();
  }, [animate, progress]);

  // Scaling happens about a bar's centre; the translate keeps its start end
  // still: for a bar of length L at scale s the shift is (L / 2)(1 - s).
  const shortScale = progress.interpolate({
    inputRange: [0, SPLIT, 1],
    outputRange: [MIN_SCALE, 1, 1],
    extrapolate: "clamp",
  });
  const shortShift = progress.interpolate({
    inputRange: [0, SPLIT, 1],
    outputRange: [-(SHORT / 2) * (1 - MIN_SCALE), 0, 0],
    extrapolate: "clamp",
  });
  const longScale = progress.interpolate({
    inputRange: [0, SPLIT, 1],
    outputRange: [MIN_SCALE, MIN_SCALE, 1],
    extrapolate: "clamp",
  });
  const longShift = progress.interpolate({
    inputRange: [0, SPLIT, 1],
    outputRange: [
      (LONG / 2) * (1 - MIN_SCALE),
      (LONG / 2) * (1 - MIN_SCALE),
      0,
    ],
    extrapolate: "clamp",
  });

  return (
    <View
      style={styles.box}
      accessibilityElementsHidden
      importantForAccessibility="no-hide-descendants"
    >
      <View style={styles.ell}>
        <Animated.View
          style={[
            styles.short,
            {
              backgroundColor: color,
              transform: [{ translateX: shortShift }, { scaleX: shortScale }],
            },
          ]}
        />
        <Animated.View
          style={[
            styles.long,
            {
              backgroundColor: color,
              transform: [{ translateY: longShift }, { scaleY: longScale }],
            },
          ]}
        />
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  box: { width: BOX, height: BOX },
  ell: {
    position: "absolute",
    width: SHORT,
    height: LONG,
    // Placed so the turned shape lands on the mockup's points (scaled to
    // this box): about (3, 10.5), (7.5, 15.5) and (17, 5.5).
    left: (BOX - SHORT) / 2,
    top: (BOX - LONG) / 2 - 2,
    transform: [{ rotate: "45deg" }],
  },
  short: {
    position: "absolute",
    left: 0,
    bottom: 0,
    width: SHORT,
    height: STROKE,
    borderRadius: STROKE / 2,
  },
  long: {
    position: "absolute",
    right: 0,
    bottom: 0,
    width: STROKE,
    height: LONG,
    borderRadius: STROKE / 2,
  },
});
