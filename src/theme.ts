import { createContext, useContext } from "react";

// Clox uses a light "paper" look by default and can flip to a dark "on-shift"
// palette while the timer is running (mirrors the web's body.clx-shift-active).
// The clay accent stays constant across both so the brand reads the same.
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
  border: string;
  warn: string;
};

export const darkColors: Palette = {
  bg: "#0f0f0e", // clx-ink
  surface: "#1c1c1a",
  surfaceAlt: "#26261f",
  text: "#f4f4f2",
  textMuted: "#a3a39b",
  accent: "#b84a2c", // clx-clay
  accentText: "#f8f5f0",
  success: "#8aa06f",
  danger: "#e2655a",
  border: "#33332d",
  warn: "#e0b15a",
};

export const lightColors: Palette = {
  bg: "#f3efe7", // warm paper
  surface: "#ffffff",
  surfaceAlt: "#ece5d8",
  text: "#1a1a17",
  textMuted: "#6a6760", // clx-stone
  accent: "#b84a2c", // clx-clay
  accentText: "#fbf8f3",
  success: "#4f5e42", // deep moss, readable on light
  danger: "#bb3b2a",
  border: "#ddd5c5",
  warn: "#9a6b15",
};

/**
 * User preference for the on-shift color switch (set on the web, read by both
 * apps from the profile):
 *   - "auto"  → dark while clocked in, light when off (the default)
 *   - "light" → always light
 *   - "dark"  → always dark
 */
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

// Light by default. A clocked-in screen provides the resolved palette to its
// subtree so shared components (e.g. the picker) follow the active theme.
export const ThemeContext = createContext<Palette>(lightColors);
export const useColors = (): Palette => useContext(ThemeContext);
