import { useEffect, useState } from "react";
import {
  Dimensions,
  Modal,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { useColors } from "../theme";
import { useTutorial, type Rect } from "./TutorialContext";

const DIM = "rgba(0,0,0,0.6)";

/**
 * Spotlight overlay for the mobile guided tour. Dims the screen (four rects
 * around the measured target, leaving a clear "hole"), draws a clay ring around
 * the target, and shows a themed card placed next to it (just above a low
 * target, just below a high one) with Back / Skip / Next. No-target steps dim
 * fully and float the card just above the bottom tab bar.
 */
export function TutorialOverlay() {
  const c = useColors();
  const insets = useSafeAreaInsets();
  const { active, step, stepIndex, stepCount, next, back, skip, measureActive } =
    useTutorial();
  const [rect, setRect] = useState<Rect | null>(null);

  useEffect(() => {
    if (!active) {
      setRect(null);
      return;
    }
    let cancelled = false;
    // Let the screen settle a frame before measuring the target.
    const id = setTimeout(() => {
      void measureActive().then((r) => {
        if (!cancelled) setRect(r);
      });
    }, 60);
    return () => {
      cancelled = true;
      clearTimeout(id);
    };
  }, [active, stepIndex, measureActive]);

  if (!active || !step) return null;

  const { width: SW, height: SH } = Dimensions.get("window");
  const last = stepIndex + 1 >= stepCount;
  const pad = 8;
  // Approx bottom tab-bar height (RN default content + safe-area inset) so the
  // spotlight never spills into it, and the "manager tools" step can target it.
  const tabBarH = 49 + insets.bottom;

  let r: { x: number; y: number; w: number; h: number } | null = null;
  if (step.bottomBar) {
    // Highlight the bottom tab bar itself.
    r = { x: 0, y: SH - tabBarH, w: SW, h: tabBarH };
  } else if (rect) {
    // Clamp to the area above the tab bar so a tall list (recent shifts) can't
    // leave the nav bar un-dimmed, and below the status bar up top.
    const top = Math.max(insets.top, rect.y - pad);
    const bottom = Math.min(rect.y + rect.height + pad, SH - tabBarH);
    r = {
      x: rect.x - pad,
      y: top,
      w: rect.width + pad * 2,
      h: Math.max(0, bottom - top),
    };
  }

  // Place the card adjacent to the spotlight so the two read as connected: just
  // above a target in the bottom half, just below one in the top half. No-target
  // steps (the manager tabs) sit just above the bottom tab bar, pointing at it.
  const cardPos: { top?: number; bottom?: number } = !r
    ? { bottom: 110 }
    : r.y + r.h / 2 > SH / 2
      ? { bottom: SH - r.y + 12 }
      : { top: r.y + r.h + 12 };

  return (
    <Modal visible transparent animationType="fade" onRequestClose={skip}>
      {r ? (
        <>
          <View
            style={{
              position: "absolute",
              left: 0,
              top: 0,
              width: SW,
              height: Math.max(0, r.y),
              backgroundColor: DIM,
            }}
          />
          <View
            style={{
              position: "absolute",
              left: 0,
              top: r.y + r.h,
              width: SW,
              height: Math.max(0, SH - (r.y + r.h)),
              backgroundColor: DIM,
            }}
          />
          <View
            style={{
              position: "absolute",
              left: 0,
              top: r.y,
              width: Math.max(0, r.x),
              height: r.h,
              backgroundColor: DIM,
            }}
          />
          <View
            style={{
              position: "absolute",
              left: r.x + r.w,
              top: r.y,
              width: Math.max(0, SW - (r.x + r.w)),
              height: r.h,
              backgroundColor: DIM,
            }}
          />
          <View
            pointerEvents="none"
            style={{
              position: "absolute",
              left: r.x,
              top: r.y,
              width: r.w,
              height: r.h,
              borderRadius: 14,
              borderWidth: 2,
              borderColor: c.accent,
            }}
          />
        </>
      ) : (
        <View style={[StyleSheet.absoluteFill, { backgroundColor: DIM }]} />
      )}

      <View
        style={{
          position: "absolute",
          left: 20,
          right: 20,
          ...cardPos,
          backgroundColor: c.surface,
          borderRadius: 18,
          borderWidth: 1,
          borderColor: c.border,
          padding: 20,
        }}
      >
        <Text
          style={{
            color: c.accent,
            fontSize: 12,
            fontWeight: "700",
            letterSpacing: 1,
            textTransform: "uppercase",
            marginBottom: 6,
          }}
        >
          {stepIndex + 1} of {stepCount}
        </Text>
        <Text
          style={{
            color: c.text,
            fontSize: 18,
            fontWeight: "800",
            marginBottom: 6,
          }}
        >
          {step.title}
        </Text>
        <Text style={{ color: c.textMuted, fontSize: 14, lineHeight: 20 }}>
          {step.body}
        </Text>
        <View
          style={{
            flexDirection: "row",
            alignItems: "center",
            justifyContent: "space-between",
            marginTop: 18,
          }}
        >
          <TouchableOpacity onPress={skip} hitSlop={8}>
            <Text style={{ color: c.textMuted, fontSize: 15, fontWeight: "600" }}>
              Skip
            </Text>
          </TouchableOpacity>
          <View style={{ flexDirection: "row", alignItems: "center", gap: 14 }}>
            {stepIndex > 0 ? (
              <TouchableOpacity onPress={back} hitSlop={8}>
                <Text
                  style={{ color: c.text, fontSize: 15, fontWeight: "600" }}
                >
                  Back
                </Text>
              </TouchableOpacity>
            ) : null}
            <TouchableOpacity
              onPress={next}
              activeOpacity={0.85}
              style={{
                backgroundColor: c.accent,
                borderRadius: 12,
                paddingVertical: 10,
                paddingHorizontal: 20,
              }}
            >
              <Text
                style={{ color: c.accentText, fontSize: 15, fontWeight: "700" }}
              >
                {last ? "Done" : "Next"}
              </Text>
            </TouchableOpacity>
          </View>
        </View>
      </View>
    </Modal>
  );
}
