import { useEffect, useState } from "react";
import { AccessibilityInfo } from "react-native";

/**
 * Whether a screen reader (VoiceOver, TalkBack) is on, and whether the
 * worker asked for reduced motion. Both start false and follow the system
 * setting as it changes. They are state, not refs, because they change what
 * the Clock screen renders.
 */
export function useAccessibilityPrefs(): {
  screenReaderOn: boolean;
  reduceMotion: boolean;
} {
  const [screenReaderOn, setScreenReaderOn] = useState(false);
  const [reduceMotion, setReduceMotion] = useState(false);

  useEffect(() => {
    let alive = true;
    void AccessibilityInfo.isScreenReaderEnabled()
      .then((on) => {
        if (alive) setScreenReaderOn(on);
      })
      .catch(() => {});
    void AccessibilityInfo.isReduceMotionEnabled()
      .then((on) => {
        if (alive) setReduceMotion(on);
      })
      .catch(() => {});
    const readerSub = AccessibilityInfo.addEventListener(
      "screenReaderChanged",
      (on: boolean) => setScreenReaderOn(on),
    );
    const motionSub = AccessibilityInfo.addEventListener(
      "reduceMotionChanged",
      (on: boolean) => setReduceMotion(on),
    );
    return () => {
      alive = false;
      readerSub.remove();
      motionSub.remove();
    };
  }, []);

  return { screenReaderOn, reduceMotion };
}
