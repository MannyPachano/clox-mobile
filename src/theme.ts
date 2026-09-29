import { createContext, useContext } from "react";

/**
 * Phase 2 reference — replaces src/theme.ts in clox-mobile.
 *
 * Changes vs production: six palette VALUES updated (see 00-README table),
 * plus additive `spacing`, `radii`, `scrim`, and `type` exports. Every
 * existing export keeps its name and shape, so all current imports keep
 * working unchanged. Deliberate contrast divergences from the web palette
 * are kept and commented; do not "align" them to the web values.
 */

export type Palette = {
  bg: string;
  surface: string;
  surfaceAlt: string;
  text: string;
  textMuted: string;
  accent: string;
  accentText: string;
  success: string;
  danger: string;
  /** A filled danger surface that carries accentText (Clock out, the error
   *  banner, the rejected badge). Its own token because `danger` doubles as a
   *  text colour on the dark surface, where it must stay light to read, while
   *  a fill under light text must be dark enough to pass 4.5:1. */
  dangerFill: string;
  /** The unfilled part of the hold-to-clock-out button, which fills with
   *  dangerFill. Darker than dangerFill so the fill reads, and it carries
   *  accentText too: 9.1:1. */
  dangerTrack: string;
  border: string;
  warn: string;
  /* The four extra project board colors (clay/moss/amber map to accent/success
     /warn). Per-theme so the small board dot stays readable on paper and on the
     dark surface, the same reason success/warn diverge above. */
  projSlate: string;
  projPlum: string;
  projPine: string;
  projSand: string;
};

export const darkColors: Palette = {
  bg: "#0f0f0e", // clx-ink
  surface: "#1c1c1a",
  surfaceAlt: "#26261f",
  text: "#f3efe7", // warm paper (was #f4f4f2): matches web dark-mode foreground
  textMuted: "#a3a39b", // lighter than web dark stone on purpose: small-text contrast
  accent: "#b84a2c", // clx-clay
  accentText: "#fbf8f3", // unified with light.accentText (web btn-primary-fg)
  success: "#8aa06f",
  danger: "#e2655a",
  // #e2655a under accentText measured 3.18:1. This is the same hue and chroma
  // (OKLCH), darkened just past 4.5:1: 4.65:1 under #fbf8f3.
  dangerFill: "#c2473e",
  dangerTrack: "#7a2a1d", // the mockup's hold button base
  border: "#33332d",
  warn: "#e0b15a",
  // Lighter tones so the dot reads on the dark surface (mirrors web dark).
  projSlate: "#93a7b8",
  projPlum: "#b593a6",
  projPine: "#8fb0a3",
  projSand: "#c2b083",
};

export const lightColors: Palette = {
  bg: "#f3efe7", // warm paper
  surface: "#fbf9f4", // web card surface (was #ffffff): warm, sits in the brand
  surfaceAlt: "#e9e4d8", // exact web paper-2 (was #ece5d8)
  text: "#0f0f0e", // exact web ink (was #1a1a17)
  textMuted: "#6a6760", // clx-stone
  accent: "#b84a2c", // clx-clay
  accentText: "#fbf8f3",
  success: "#4f5e42", // deep moss on purpose: readable at small sizes on paper
  danger: "#bb3b2a", // darker than web danger on purpose: readable on paper
  dangerFill: "#bb3b2a", // 5.26:1 under accentText already
  dangerTrack: "#7a2a1d",
  border: "#ddd5c5",
  // Darker than web amber on purpose: 4.78:1 on paper (bg), 5.21:1 on
  // surface, so 14px text passes 4.5:1 (#9a6b15 measured 4.08:1 on paper).
  warn: "#8c6112",
  // Deepened on purpose, same reason as success/warn: readable on paper.
  projSlate: "#47586a",
  projPlum: "#664459",
  projPine: "#2f5044",
  projSand: "#7a6a3f",
};

/** Shared modal/overlay scrim. ClockScreen may keep its lighter 0.45 locally. */
export const scrim = "rgba(0,0,0,0.6)";

/** Spacing scale. Use for new/touched styles; no big-bang migration. */
export const spacing = {
  xs: 4,
  sm: 8,
  md: 12,
  lg: 16,
  xl: 20,
  xxl: 24,
  xxxl: 32,
} as const;

/** Corner radii. md (14) is the app's dominant card/button radius. */
export const radii = {
  sm: 10,
  md: 14,
  lg: 18,
  pill: 999,
} as const;

/**
 * Type ramp reflecting current real usage (heavy weights are deliberate:
 * glare and glove-distance readability). Timer digits must be tabular so
 * the running clock does not jitter.
 */
export const type = {
  timer: {
    fontSize: 52,
    fontWeight: "800",
    fontVariant: ["tabular-nums"],
  },
  title: { fontSize: 22, fontWeight: "700" },
  body: { fontSize: 16, fontWeight: "400" },
  label: { fontSize: 14, fontWeight: "600" },
  caption: { fontSize: 13, fontWeight: "500" },
} as const;

export type ThemePreference = "auto" | "light" | "dark";

export function normalizeThemePreference(v: unknown): ThemePreference {
  return v === "light" || v === "dark" ? v : "auto";
}

export function resolvePalette(
  pref: ThemePreference,
  shiftActive: boolean,
): Palette {
  if (pref === "light") return lightColors;
  if (pref === "dark") return darkColors;
  return shiftActive ? darkColors : lightColors;
}

export const ThemeContext = createContext<Palette>(lightColors);
export const useColors = (): Palette => useContext(ThemeContext);
