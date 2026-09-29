import { useCallback, useEffect, useRef, useState } from "react";
import {
  Animated,
  Easing,
  Pressable,
  StyleSheet,
  Text,
  View,
  type LayoutChangeEvent,
  type StyleProp,
  type TextStyle,
  type ViewStyle,
} from "react-native";

import {
  HOLD_TO_CLOCK_OUT_MS,
  KEEP_HOLDING_MS,
  holdLabel,
  holdPhaseOnRelease,
  holdProgressAt,
  holdResetMs,
  type HoldPhase,
} from "../clock-moment";

/**
 * Hold to clock out. Pressing fills the button over HOLD_TO_CLOCK_OUT_MS on
 * the native driver; when the fill finishes, `onComplete` runs once. Letting
 * go early runs the fill back to empty and the label says "Keep holding"
 * for KEEP_HOLDING_MS. A scroll that steals the touch counts as letting go.
 *
 * Assistive tech that activates instead of pressing (Switch Control, Voice
 * Control) gets the same clock-out through the "activate" action. The Clock
 * screen shows a plain Clock out button instead of this one while a screen
 * reader is on.
 */
export function HoldToClockOut({
  onComplete,
  disabled,
  trackColor,
  fillColor,
  textColor,
  style,
  textStyle,
}: {
  onComplete: () => void;
  disabled: boolean;
  trackColor: string;
  fillColor: string;
  textColor: string;
  style?: StyleProp<ViewStyle>;
  textStyle?: StyleProp<TextStyle>;
}) {
  const [progress] = useState(() => new Animated.Value(0));
  const [phase, setPhase] = useState<HoldPhase>("idle");
  const [width, setWidth] = useState(0);
  const animRef = useRef<Animated.CompositeAnimation | null>(null);
  const pressedAtRef = useRef(0);
  const completedRef = useRef(false);
  const nudgeRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const onCompleteRef = useRef(onComplete);
  useEffect(() => {
    onCompleteRef.current = onComplete;
  }, [onComplete]);

  const clearNudge = () => {
    if (nudgeRef.current !== null) {
      clearTimeout(nudgeRef.current);
      nudgeRef.current = null;
    }
  };

  // Stop everything on unmount (the screen flips to Not clocked in as soon
  // as the clock-out is saved, which unmounts this button).
  useEffect(
    () => () => {
      animRef.current?.stop();
      if (nudgeRef.current !== null) clearTimeout(nudgeRef.current);
    },
    [],
  );

  const complete = useCallback(() => {
    if (completedRef.current) return;
    completedRef.current = true;
    setPhase("done");
    onCompleteRef.current();
  }, []);

  const onPressIn = useCallback(() => {
    if (disabled || completedRef.current) return;
    clearNudge();
    animRef.current?.stop();
    pressedAtRef.current = Date.now();
    setPhase("holding");
    progress.setValue(0);
    const anim = Animated.timing(progress, {
      toValue: 1,
      duration: HOLD_TO_CLOCK_OUT_MS,
      easing: Easing.linear,
      useNativeDriver: true,
    });
    animRef.current = anim;
    anim.start(({ finished }) => {
      // `finished` is false when a release stopped it first.
      if (finished) complete();
    });
  }, [disabled, progress, complete]);

  const onPressOut = useCallback(() => {
    if (completedRef.current) return;
    animRef.current?.stop();
    animRef.current = null;
    const reached = holdProgressAt(Date.now() - pressedAtRef.current);
    setPhase(holdPhaseOnRelease(false));
    Animated.timing(progress, {
      toValue: 0,
      duration: holdResetMs(reached),
      easing: Easing.out(Easing.quad),
      useNativeDriver: true,
    }).start();
    clearNudge();
    nudgeRef.current = setTimeout(() => {
      nudgeRef.current = null;
      setPhase((p) => (p === "released" ? "idle" : p));
    }, KEEP_HOLDING_MS);
  }, [progress]);

  const onLayout = useCallback((e: LayoutChangeEvent) => {
    setWidth(e.nativeEvent.layout.width);
  }, []);

  // The fill is a full-width bar slid in from the left (translateX runs on
  // the native driver; width would not). Until the button is measured there
  // is nothing to slide, so the bar is left out.
  const slide = progress.interpolate({
    inputRange: [0, 1],
    outputRange: [-width, 0],
  });

  return (
    <Pressable
      onPressIn={onPressIn}
      onPressOut={onPressOut}
      disabled={disabled}
      onLayout={onLayout}
      accessibilityRole="button"
      accessibilityLabel="Hold to clock out"
      accessibilityHint="Press and hold until the button fills to clock out."
      accessibilityState={{ disabled }}
      accessibilityActions={[{ name: "activate" }]}
      onAccessibilityAction={(e) => {
        if (e.nativeEvent.actionName === "activate" && !disabled) complete();
      }}
      style={[style, styles.clip, { backgroundColor: trackColor }]}
    >
      {width > 0 ? (
        <Animated.View
          pointerEvents="none"
          style={[
            StyleSheet.absoluteFill,
            { backgroundColor: fillColor, transform: [{ translateX: slide }] },
          ]}
        />
      ) : null}
      <View pointerEvents="none">
        <Text style={[textStyle, { color: textColor }]}>{holdLabel(phase)}</Text>
      </View>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  clip: { overflow: "hidden" },
});
