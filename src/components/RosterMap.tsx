import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  AccessibilityInfo,
  ActivityIndicator,
  Animated,
  findNodeHandle,
  Modal,
  PanResponder,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from "react-native";
import { useFocusEffect } from "@react-navigation/native";
import DateTimePicker from "@react-native-community/datetimepicker";
import type { Region } from "react-native-maps";

import { getManagerMapRange, type MapRangeData, type Option } from "../api";
import { zonedFormat } from "../lib/zoned-time";
import { getAccessToken } from "../supabase";
import { lightColors as c, radii, scrim } from "../theme";
import { SelectField } from "./SelectField";

// react-native-maps is the app's only heavy native map dependency. It is
// require()d lazily (below, on first render of this component behind the Map
// toggle) so app startup never pays for it — see Part D. `import type` above is
// erased at build time and does not load the module.
type MapsModule = typeof import("react-native-maps");
let mapsModule: MapsModule | null = null;
function loadMaps(): MapsModule | null {
  if (!mapsModule) {
    try {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      mapsModule = require("react-native-maps") as MapsModule;
    } catch {
      // Native module missing (e.g. Expo Go, or an old build without the map
      // dependency). Callers show a "needs the latest build" fallback.
      return null;
    }
  }
  return mapsModule;
}

const PRIVACY_CAPTION =
  "Pins are where punches happened. Clox does not track location between punches.";

type RangeMode = "day" | "week" | "month" | "custom";

function pad(n: number): string {
  return n.toString().padStart(2, "0");
}
function dayKey(d: Date): string {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}
function addDays(d: Date, n: number): Date {
  const x = new Date(d);
  x.setDate(x.getDate() + n);
  return x;
}
function mondayOf(d: Date): Date {
  const x = new Date(d);
  x.setHours(0, 0, 0, 0);
  const day = x.getDay();
  x.setDate(x.getDate() + (day === 0 ? -6 : 1 - day));
  return x;
}

function computeRange(
  mode: RangeMode,
  custom: { fromKey: string; toKey: string } | null,
): { fromKey: string; toKey: string } {
  const today = new Date();
  if (mode === "week") {
    const mon = mondayOf(today);
    return { fromKey: dayKey(mon), toKey: dayKey(addDays(mon, 6)) };
  }
  if (mode === "month") {
    const first = new Date(today.getFullYear(), today.getMonth(), 1);
    const last = new Date(today.getFullYear(), today.getMonth() + 1, 0);
    return { fromKey: dayKey(first), toKey: dayKey(last) };
  }
  if (mode === "custom" && custom) return custom;
  // Day, and Custom until two dates are picked.
  const k = dayKey(today);
  return { fromKey: k, toKey: k };
}

/**
 * Apple Maps and Google Maps disagree about how to calm a map down. iOS has a
 * first-class muted style; Android needs the style spelled out. Both aim at
 * the same thing: the map is context, the punches are the content, so the
 * basemap goes grey and stops advertising restaurants.
 */
const ANDROID_MUTED_STYLE = [
  { elementType: "geometry", stylers: [{ saturation: -80 }, { lightness: 12 }] },
  { elementType: "labels.icon", stylers: [{ visibility: "off" }] },
  {
    elementType: "labels.text.fill",
    stylers: [{ saturation: -100 }, { lightness: -12 }],
  },
  {
    elementType: "labels.text.stroke",
    stylers: [{ saturation: -100 }, { lightness: 60 }],
  },
  { featureType: "poi", stylers: [{ visibility: "off" }] },
  {
    featureType: "road",
    elementType: "geometry",
    stylers: [{ saturation: -70 }, { lightness: 20 }],
  },
  {
    featureType: "transit",
    stylers: [{ visibility: "off" }],
  },
  {
    featureType: "water",
    elementType: "geometry",
    stylers: [{ saturation: -60 }, { lightness: 25 }],
  },
];

/** Metres per degree of latitude. Good to a fraction of a percent anywhere. */
const M_PER_DEG_LAT = 111_320;

/** Metres between two coordinates, flat-earth approximation. Fine at the tens
 *  of metres this is used for. */
function metresApart(
  aLat: number,
  aLng: number,
  bLat: number,
  bLng: number,
): number {
  const dLat = (aLat - bLat) * M_PER_DEG_LAT;
  const lngScale =
    M_PER_DEG_LAT * Math.max(0.15, Math.cos((aLat * Math.PI) / 180));
  const dLng = (aLng - bLng) * lngScale;
  return Math.hypot(dLat, dLng);
}

/**
 * Above this visible span, a group of punches is drawn as one counted pin
 * instead of a fan. About 9 km of map height: wider than any worksite, so a
 * fan only ever happens when you are actually looking at a site.
 */
const FAN_MAX_SPAN_LAT = 0.08;

/** A fan ring can never outgrow a worksite, whatever the arithmetic says. */
const FAN_RADIUS_CAP_M = 120;

/**
 * How close two punches have to be to count as the same spot.
 *
 * It scales with the visible span, because "do these overlap" is a question
 * about pixels, not metres. At cluster zooms the net stays proportional so a
 * whole metro area folds into one counted pin; at fan zooms it is capped at
 * 60 m so two genuinely separate nearby sites never merge into one ring.
 */
function colocatedMetres(spanLatDelta: number): number {
  const proportional = spanLatDelta * M_PER_DEG_LAT * 0.04;
  return spanLatDelta > FAN_MAX_SPAN_LAT
    ? Math.max(15, proportional)
    : Math.min(60, Math.max(15, proportional));
}

type PunchCluster<T> = {
  /** Stable across renders that do not regroup, so React does not remount a
   *  cluster (and lose its snapshot) on every idle pan. */
  key: string;
  /** Member MEAN — where the count pin renders. Never frame a zoom on this:
   *  in a skewed group (ten punches south, two north) the mean hugs the
   *  majority, and an extent-sized window centred on it cuts the minority
   *  off. */
  lat: number;
  lng: number;
  /** Extent MIDPOINT — what a tap centres its framing on. mid ± 0.7·span
   *  covers [min − 0.2·span, max + 0.2·span], so every member is inside
   *  the requested window by construction. */
  midLat: number;
  midLng: number;
  /** The members' own extent, so tapping can frame the real group rather than
   *  a fixed box around its centre. */
  spanLat: number;
  spanLng: number;
  members: T[];
};

/**
 * Decide how punches should be drawn: individual pins, fanned apart when they
 * share a spot, plus counted clusters for groups being viewed from too far
 * away to fan honestly.
 *
 * The previous version fanned at every zoom with a span-proportional radius
 * and no cap. At a continental span that arithmetic came to a 1,100 km ring
 * of pins across North America. Proportional was the right idea and wrong
 * without a ceiling: fanning only tells the truth while the offset is small
 * against the ground, and past a certain zoom the honest answer is not
 * "spread them out" but "there are 25 punches here".
 *
 * Offsets are display only. Callouts report the real punch, and the region fit
 * is computed from RAW coordinates so a fan can never inflate it.
 */
function presentColocated<
  T extends { clockInLatitude: number; clockInLongitude: number },
>(
  punches: T[],
  spanLatDelta: number,
): {
  pins: (T & { fanLat: number; fanLng: number })[];
  clusters: PunchCluster<T>[];
} {
  const nearM = colocatedMetres(spanLatDelta);
  const groups: T[][] = [];
  for (const p of punches) {
    const hit = groups.find((g) =>
      g.some(
        (q) =>
          metresApart(
            p.clockInLatitude,
            p.clockInLongitude,
            q.clockInLatitude,
            q.clockInLongitude,
          ) <= nearM,
      ),
    );
    if (hit) hit.push(p);
    else groups.push([p]);
  }

  const pins: (T & { fanLat: number; fanLng: number })[] = [];
  const clusters: PunchCluster<T>[] = [];

  for (const group of groups) {
    if (group.length === 1) {
      const only = group[0]!;
      pins.push({
        ...only,
        fanLat: only.clockInLatitude,
        fanLng: only.clockInLongitude,
      });
      continue;
    }
    if (spanLatDelta > FAN_MAX_SPAN_LAT) {
      // Zoomed out: one honest counted pin at the group's centre.
      const lats = group.map((q) => q.clockInLatitude);
      const lngs = group.map((q) => q.clockInLongitude);
      const lat = lats.reduce((a, b) => a + b, 0) / group.length;
      const lng = lngs.reduce((a, b) => a + b, 0) / group.length;
      const latMin = Math.min(...lats);
      const latMax = Math.max(...lats);
      const lngMin = Math.min(...lngs);
      const lngMax = Math.max(...lngs);
      clusters.push({
        key: `cluster-${lat.toFixed(5)},${lng.toFixed(5)}-${group.length}`,
        lat,
        lng,
        midLat: (latMin + latMax) / 2,
        midLng: (lngMin + lngMax) / 2,
        spanLat: latMax - latMin,
        spanLng: lngMax - lngMin,
        members: group,
      });
      continue;
    }
    // Zoomed in: fan, in metres, capped from both ends.
    //
    // The floor decays with the span rather than sitting at a fixed 18 m. A
    // constant floor is a growing lie as you zoom in: at a 50 m view it pushes
    // a pin a third of the screen off its real spot, and straight out of the
    // worksite circle drawn on the same map. Nothing may exceed a quarter of
    // the visible height, so the offset always reads as a nudge.
    const ceiling = Math.min(
      FAN_RADIUS_CAP_M,
      spanLatDelta * M_PER_DEG_LAT * 0.25,
    );
    const base = Math.min(
      ceiling,
      Math.max(
        Math.min(18, spanLatDelta * M_PER_DEG_LAT * 0.06),
        spanLatDelta * M_PER_DEG_LAT * 0.06,
      ),
    );
    const radiusM = Math.min(
      ceiling,
      base * Math.min(2, Math.max(1, group.length / 6)),
    );
    group.forEach((q, i) => {
      const angle = (2 * Math.PI * i) / group.length;
      const dLat = (radiusM * Math.cos(angle)) / M_PER_DEG_LAT;
      const lngScale =
        M_PER_DEG_LAT *
        Math.max(0.15, Math.cos((q.clockInLatitude * Math.PI) / 180));
      const dLng = (radiusM * Math.sin(angle)) / lngScale;
      pins.push({
        ...q,
        fanLat: q.clockInLatitude + dLat,
        fanLng: q.clockInLongitude + dLng,
      });
    });
  }
  return { pins, clusters };
}

// Punch times and dates render in the ORG's zone (data.timeZone) — the zone
// the server resolved the range keys in, the zone the sheet's day headers
// group by, and the zone the web sidebar shows. Mixing zones on one screen
// is the failure mode: a device-local "2:30 AM" under an org-day "Jul 23"
// header reads as the wrong day. `tz` undefined (no data yet, or an old
// server payload without the field) falls back to the device zone.
function clock(ms: number, tz: string | undefined): string {
  return zonedFormat(
    "clock",
    "en-US",
    { hour: "numeric", minute: "2-digit", hour12: true },
    tz,
    ms,
  );
}

function shortDate(ms: number, tz: string | undefined): string {
  return zonedFormat(
    "shortDate",
    "en-US",
    { month: "short", day: "numeric" },
    tz,
    ms,
  );
}

function initials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return "?";
  if (parts.length === 1) return parts[0]!.slice(0, 2).toUpperCase();
  return (parts[0]![0]! + parts[parts.length - 1]![0]!).toUpperCase();
}

/** The seven-color palette token a punch's project carries, resolved to this
 *  screen's own swatch for the sheet row's dot — the same seven hues the
 *  web app uses (clay/moss/amber/slate/plum/pine/sand), mapped onto this
 *  file's `c` (this screen is pinned to the light palette; see its import). */
function projectDotColor(token: string | null): string | null {
  switch (token) {
    case "clay":
      return c.accent;
    case "moss":
      return c.success;
    case "amber":
      return c.warn;
    case "slate":
      return c.projSlate;
    case "plum":
      return c.projPlum;
    case "pine":
      return c.projPine;
    case "sand":
      return c.projSand;
    default:
      return null;
  }
}

// The sheet's day headers group by the ORG's calendar day, not the manager's
// phone's — the server already resolved `from`/`to` and drew every punch's
// window in the org timeZone (returned on the payload as data.timeZone), so
// display grouping has to agree with it. Getting this wrong is silent and
// specific: a manager checking Day in an org east of them sees punches from
// the evening before spill into their own "WED, JUL 23" day header, right
// under a peek line and range label that both say "Jul 24" — the two
// surfaces on the same screen disagreeing about what day it is. `tz`
// undefined (no data yet, or an old server not yet returning the field)
// falls back to the device's own zone — the previous, imperfect behavior,
// not a crash.
function dayKeyInZone(ms: number, tz: string | undefined): string {
  return zonedFormat(
    "dayKey",
    "en-CA",
    { year: "numeric", month: "2-digit", day: "2-digit" },
    tz,
    ms,
  );
}
function dayHeadingInZone(ms: number, tz: string | undefined): string {
  return zonedFormat(
    "dayHead",
    "en-US",
    { weekday: "short", month: "short", day: "numeric" },
    tz,
    ms,
  );
}

/** The bottom sheet's collapsed height: the grab handle plus the count line.
 *  Also the map's bottom padding, so the Google logo and Apple legal text
 *  ride above the peek bar instead of underneath it. */
const SHEET_PEEK_H = 64;

/** The half snap covers this share of the sheet's own maximum extension
 *  (§7b item 3: 0.46 fit barely one row after the header). */
const SHEET_HALF_RATIO = 0.6;

/** However short the map is, the sheet's tallest state always leaves room
 *  for at least this much list below the header — about two rows. Below
 *  this the fixed "leave 88px of map visible" rule softens rather than the
 *  whole feature collapsing to a single dead position (peek === half). */
const SHEET_MIN_LIST_H = 160;

/** Once the fan has re-presented at a row tap's target region, retry this
 *  many times, this many ms apart, before giving up on opening the pin's
 *  callout. Bounded so an unreachable marker (still clustered, or dropped
 *  by a reload that lands mid-poll) fails quietly instead of firing later
 *  on some unrelated pan. */
const CALLOUT_MAX_ATTEMPTS = 6;
const CALLOUT_RETRY_MS = 180;

/** A region that bounds all worksites + punches with a little padding. */
function boundsRegion(data: MapRangeData): Region | null {
  const pts: { lat: number; lng: number }[] = [];
  for (const w of data.worksites) pts.push({ lat: w.latitude, lng: w.longitude });
  for (const p of data.punches)
    pts.push({ lat: p.clockInLatitude, lng: p.clockInLongitude });
  if (pts.length === 0) return null;
  let minLat = pts[0]!.lat,
    maxLat = pts[0]!.lat,
    minLng = pts[0]!.lng,
    maxLng = pts[0]!.lng;
  for (const p of pts) {
    minLat = Math.min(minLat, p.lat);
    maxLat = Math.max(maxLat, p.lat);
    minLng = Math.min(minLng, p.lng);
    maxLng = Math.max(maxLng, p.lng);
  }
  const latDelta = Math.max((maxLat - minLat) * 1.4, 0.01);
  const lngDelta = Math.max((maxLng - minLng) * 1.4, 0.01);
  return {
    latitude: (minLat + maxLat) / 2,
    longitude: (minLng + maxLng) / 2,
    latitudeDelta: latDelta,
    longitudeDelta: lngDelta,
  };
}

const RANGE_LABELS: Record<RangeMode, string> = {
  day: "Day",
  week: "Week",
  month: "Month",
  custom: "Custom",
};

/** "YYYY-MM-DD" to a local Date at noon (noon dodges DST edges). */
function keyToDate(key: string): Date {
  const [y, m, d] = key.split("-").map(Number);
  return new Date(y ?? 1970, (m ?? 1) - 1, d ?? 1, 12, 0, 0, 0);
}

/** "Jul 1", with the year when it is not the current one. */
function rangeLabel(key: string): string {
  const d = keyToDate(key);
  const M = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];
  const sameYear = d.getFullYear() === new Date().getFullYear();
  return `${M[d.getMonth()]} ${d.getDate()}${sameYear ? "" : `, ${d.getFullYear()}`}`;
}

/**
 * From and To for the Custom pill. Reversed ends are swapped on Apply rather
 * than refused: picking the later date first is a normal way to think, and an
 * error message would be pedantry.
 */
function CustomRangeSheet({
  initial,
  onCancel,
  onApply,
}: {
  initial: { fromKey: string; toKey: string };
  onCancel: () => void;
  onApply: (range: { fromKey: string; toKey: string }) => void;
}) {
  // Mounted only while open, and keyed on the active range, so every open
  // seeds from what is actually on screen rather than from whatever was last
  // typed into a sheet the manager then cancelled. That is a fresh mount
  // rather than an effect syncing props into state.
  const [from, setFrom] = useState<Date>(() => keyToDate(initial.fromKey));
  const [to, setTo] = useState<Date>(() => keyToDate(initial.toKey));
  const [picking, setPicking] = useState<"from" | "to" | null>(null);

  const iosInline = Platform.OS === "ios";

  return (
    <Modal visible transparent animationType="slide" onRequestClose={onCancel}>
      <Pressable style={styles.backdrop} onPress={onCancel}>
        <Pressable style={styles.sheet} onPress={() => {}}>
          <Text style={styles.sheetTitle}>Custom range</Text>

          <View style={styles.sheetBody}>
            <Text style={styles.fieldLabel}>From</Text>
            {iosInline ? (
              <DateTimePicker
                value={from}
                mode="date"
                display="compact"
                // Pinned, like TimeField. Left to the system it renders white
                // text on this always-light sheet whenever the phone is in
                // dark mode.
                themeVariant="light"
                onChange={(_e, d) => d && setFrom(d)}
                style={styles.iosPicker}
              />
            ) : (
              <>
                <TouchableOpacity
                  style={styles.fieldBtn}
                  onPress={() => setPicking("from")}
                  accessibilityRole="button"
                >
                  <Text style={styles.fieldValue}>{rangeLabel(dayKey(from))}</Text>
                </TouchableOpacity>
                {picking === "from" ? (
                  <DateTimePicker
                    value={from}
                    mode="date"
                    onChange={(_e, d) => {
                      setPicking(null);
                      if (d) setFrom(d);
                    }}
                  />
                ) : null}
              </>
            )}

            <Text style={[styles.fieldLabel, { marginTop: 14 }]}>To</Text>
            {iosInline ? (
              <DateTimePicker
                value={to}
                mode="date"
                display="compact"
                themeVariant="light"
                onChange={(_e, d) => d && setTo(d)}
                style={styles.iosPicker}
              />
            ) : (
              <>
                <TouchableOpacity
                  style={styles.fieldBtn}
                  onPress={() => setPicking("to")}
                  accessibilityRole="button"
                >
                  <Text style={styles.fieldValue}>{rangeLabel(dayKey(to))}</Text>
                </TouchableOpacity>
                {picking === "to" ? (
                  <DateTimePicker
                    value={to}
                    mode="date"
                    onChange={(_e, d) => {
                      setPicking(null);
                      if (d) setTo(d);
                    }}
                  />
                ) : null}
              </>
            )}
          </View>

          <View style={styles.sheetActions}>
            <TouchableOpacity onPress={onCancel} accessibilityRole="button">
              <Text style={styles.cancel}>Cancel</Text>
            </TouchableOpacity>
            <TouchableOpacity
              style={styles.apply}
              accessibilityRole="button"
              onPress={() => {
                const a = dayKey(from);
                const b = dayKey(to);
                onApply(
                  a <= b
                    ? { fromKey: a, toKey: b }
                    : { fromKey: b, toKey: a },
                );
              }}
            >
              <Text style={styles.applyText}>Apply</Text>
            </TouchableOpacity>
          </View>
        </Pressable>
      </Pressable>
    </Modal>
  );
}

/**
 * One punch row in the bottom sheet, memoized. The list is a plain ScrollView
 * with up to 400 rows and no virtualization, so without this every render of
 * the map — a snap, a selection change, a data reload — reconciled all 400
 * rows. That reconciliation used to run on the UI thread's spare time; now
 * that the sheet spring is JS-driven (so its position can be read
 * synchronously on grant), a 400-row burst racing the spring's first frames
 * would hitch the start of a snap. Memoizing keys each row to its own punch,
 * site, selected flag, and zone: a snap changes none of those, so no row
 * re-renders; a selection change flips `selected` on exactly two rows. The
 * parent must pass STABLE onPress/onMeasureY (useCallback) or the shallow
 * compare never skips. Punch objects are stable references between renders
 * (the list filters/sorts data.punches, never re-spreads it), which is what
 * makes the compare hold.
 */
type SheetRowProps = {
  punch: MapRangeData["punches"][number];
  site: string | undefined;
  selected: boolean;
  orgTz: string | undefined;
  onPress: (p: MapRangeData["punches"][number]) => void;
  onMeasureY: (id: string, y: number) => void;
};
const SheetRow = memo(function SheetRow({
  punch: p,
  site,
  selected,
  orgTz,
  onPress,
  onMeasureY,
}: SheetRowProps) {
  const onClock = p.clockOutMs == null;
  // Same date-truth rule as the callouts: an out on another day says so.
  const outOnAnotherDay =
    p.clockOutMs != null &&
    shortDate(p.clockOutMs, orgTz) !== shortDate(p.clockInMs, orgTz);
  const time = onClock
    ? `On shift since ${clock(p.clockInMs, orgTz)}`
    : `${clock(p.clockInMs, orgTz)} to ${clock(p.clockOutMs!, orgTz)}${
        outOnAnotherDay ? ` · ${shortDate(p.clockOutMs!, orgTz)}` : ""
      }`;
  const timeLine = site ? `${time} · ${site}` : time;
  const dotColor = projectDotColor(p.projectColor);
  return (
    <Pressable
      onLayout={(e) => onMeasureY(p.id, e.nativeEvent.layout.y)}
      onPress={() => onPress(p)}
      style={[styles.sheetRow, selected && styles.sheetRowSelected]}
      accessibilityRole="button"
      accessibilityLabel={`${p.displayName}, ${time}${site ? `, ${site}` : ""}${p.projectName ? `, ${p.projectName}` : ""}`}
      accessibilityState={{ selected }}
    >
      <View
        style={[
          styles.sheetDisc,
          onClock ? styles.sheetDiscOn : styles.sheetDiscDone,
        ]}
      >
        <Text style={styles.sheetDiscText}>{initials(p.displayName)}</Text>
      </View>
      {/* Three fixed lines, never a wrap: name, then time and place, then
          the project only when one exists (§7b item 5 — one Text block
          wrapping all three ran together and stuttered whenever the
          project name echoed the site name, e.g. "Riverside Heights" next
          to "Riverside Heights Rough-In"). */}
      <View style={styles.sheetRowBody}>
        <Text style={styles.sheetRowName} numberOfLines={1}>
          {p.displayName}
        </Text>
        <Text style={styles.sheetRowMeta} numberOfLines={1}>
          {timeLine}
        </Text>
        {p.projectName ? (
          <View style={styles.sheetRowProjectLine}>
            {dotColor ? (
              <View
                style={[styles.sheetProjectDot, { backgroundColor: dotColor }]}
              />
            ) : null}
            <Text style={styles.sheetRowProject} numberOfLines={1}>
              {p.projectName}
            </Text>
          </View>
        ) : null}
      </View>
    </Pressable>
  );
});

export function RosterMap() {
  const Maps = useMemo(() => loadMaps(), []);
  const [mode, setMode] = useState<RangeMode>("day");
  const [data, setData] = useState<MapRangeData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);
  // react-native-maps only snapshots a custom marker View while
  // tracksViewChanges is true; left false from mount the dots/initials render
  // blank. Keep it true briefly (each time the pins change) so they paint, then
  // flip it off for scroll/zoom performance.
  const [trackMarkers, setTrackMarkers] = useState(true);
  const [custom, setCustom] = useState<{
    fromKey: string;
    toKey: string;
  } | null>(null);
  const [customOpen, setCustomOpen] = useState(false);
  // Typed off the lazily-required module's own type, so this stays a
  // type-only reference and never pulls react-native-maps into the bundle
  // ahead of the Map toggle.
  const mapRef = useRef<InstanceType<MapsModule["default"]> | null>(null);
  // The span actually on screen, which is the initial fit until the manager
  // pans or zooms. The fan is recomputed from it, so pins stay separated when
  // zoomed out and settle back onto their real spots when zoomed in. Fanning
  // once from the opening region would leave a pin hundreds of metres from its
  // punch at street level, which the privacy caption says never happens.
  const [viewSpan, setViewSpan] = useState<number | null>(null);
  // Whose pins to show. The web map has the same control; without it a busy
  // month is a pile of pins with no way to ask "where was Diego?".
  const [whoId, setWhoId] = useState<string | null>(null);

  const range = useMemo(() => computeRange(mode, custom), [mode, custom]);

  const load = useCallback(async () => {
    setLoading(true);
    setError(false);
    const token = await getAccessToken();
    if (!token) {
      setLoading(false);
      setError(true);
      return;
    }
    try {
      const res = await getManagerMapRange(token, range.fromKey, range.toKey);
      if (res.ok) {
        setData(res.data);
        // Deliberately NOT clearing viewSpan here. The MapView is uncontrolled
        // (initialRegion applies at mount only), so a reload leaves the camera
        // exactly where it was. Clearing it would fall back to the new data's
        // fit and decide cluster-or-fan from a span nobody is looking at,
        // drawing counted clusters over a street-level view.
      } else {
        // Drop the old pins. Keeping them would leave the previous range's
        // punches on screen under a line naming the range that just failed,
        // and would hide the Try again button behind a map that looks fine.
        setData(null);
        setError(true);
      }
    } catch {
      setData(null);
      setError(true);
    } finally {
      setLoading(false);
    }
  }, [range.fromKey, range.toKey]);

  // Refetch on screen focus and whenever the range changes (load's identity
  // tracks range.fromKey/toKey). useFocusEffect, not useEffect, so the fetch's
  // setState isn't a cascading-render effect.
  useFocusEffect(
    useCallback(() => {
      void load();
    }, [load]),
  );

  const region = useMemo(() => (data ? boundsRegion(data) : null), [data]);
  const people = useMemo<Option[]>(() => {
    if (!data) return [];
    const byId = new Map<string, string>();
    for (const p of data.punches) byId.set(p.userId, p.displayName);
    return [...byId.entries()]
      .map(([id, name]) => ({ id, name }))
      .sort((a, b) => a.name.localeCompare(b.name));
  }, [data]);

  // A name that leaves the range (or a range with no punches for them) must not
  // strand the map on an empty filter.
  const activeWhoId =
    whoId && people.some((o) => o.id === whoId) ? whoId : null;

  const visiblePunches = useMemo(
    () =>
      data
        ? activeWhoId
          ? data.punches.filter((p) => p.userId === activeWhoId)
          : data.punches
        : [],
    [data, activeWhoId],
  );

  const { pins: fannedPunches, clusters } = useMemo(
    () =>
      data
        ? presentColocated(
            visiblePunches,
            viewSpan ?? region?.latitudeDelta ?? 0.01,
          )
        : { pins: [], clusters: [] },
    [data, visiblePunches, region, viewSpan],
  );

  /**
   * Identity of the markers currently drawn. Keyed on this rather than on
   * `data`, because the drawn set now changes on ZOOM (a group flips between
   * one counted cluster and several fanned pins) and on the Who filter, not
   * only when a new range arrives. A marker mounted while tracksViewChanges is
   * false is never snapshotted and paints blank, which is the bug fd1acce
   * already fixed once for punch pins and which clusters reintroduced.
   */
  const markerIdentity = `${activeWhoId ?? "all"}|${fannedPunches.length}|${clusters
    .map((cl) => cl.key)
    .join(",")}`;

  // Re-enable marker snapshotting when the drawn set changes, then turn it off
  // after they have painted so scroll/zoom stays cheap.
  useEffect(() => {
    setTrackMarkers(true);
    const id = setTimeout(() => setTrackMarkers(false), 1500);
    return () => clearTimeout(id);
  }, [markerIdentity]);

  // ── The bottom sheet: the same linked punch list the web sidebar carries,
  //    as a Google Maps style sheet over the map. Three snaps: a peek bar,
  //    half the map area, and a full drag that still leaves a map sliver
  //    visible. One selection shared by rows and pins.

  const [selectedPunchId, setSelectedPunchId] = useState<string | null>(null);
  const [mapH, setMapH] = useState(0);
  // Marker instances by punch id, so a row tap can open a pin's callout.
  // Structural type on purpose: the maps module is lazily required, and all
  // the sheet needs from a marker is showCallout.
  const markerRefs = useRef(new Map<string, { showCallout?: () => void }>());
  // Guards the callout-opening poll below (see onRowPress): bumped on every
  // row tap so an earlier tap's still-running poll recognizes it has been
  // superseded and stops touching the map instead of opening a stale
  // callout later.
  const calloutAttemptSeq = useRef(0);
  // The last cluster-tap framing request. A re-tap of the SAME group at the
  // SAME framing means the camera is already there — no settle event fires,
  // nothing regroups, and without this memory the pin would be dead forever
  // for a dense chain whose extent set the current fit. The re-tap
  // escalates instead (see the cluster onPress). Cleared when the camera
  // settles meaningfully off the stored centre: a pan means the next tap
  // should frame the group again, not zoom into its middle.
  const lastClusterZoom = useRef<{
    latitude: number;
    longitude: number;
    latitudeDelta: number;
    longitudeDelta: number;
  } | null>(null);

  type SheetSnap = "peek" | "half" | "full";

  // Sheet geometry. The panel is a FIXED height (fullH, the tallest state);
  // translateY reveals varying amounts of it. 0 = fully extended; larger
  // values slide more of it below the fold. fullH normally leaves at least
  // 88px of map (and its pins) visible above the sheet, so a drag never
  // hides the very thing the list is describing — but on a short map (a lot
  // of chrome stacked above it, a small phone, a raised OS text size) that
  // 88px reserve alone can crush the list to nothing, collapsing peek and
  // half onto the same position and making the whole feature a no-op. The
  // SHEET_MIN_LIST_H floor guarantees usable list room first and lets the
  // map reserve shrink instead, capped at mapH itself so the sheet is never
  // taller than its own container. The gesture reads this geometry through
  // a ref because the PanResponder is created once and must not close over
  // a stale height; the ref is synced by the effect below, never read
  // during render.
  const fullH = Math.min(
    mapH,
    Math.max(mapH - 88, SHEET_PEEK_H + SHEET_MIN_LIST_H),
  );
  const halfH = Math.min(
    Math.max(Math.round(mapH * SHEET_HALF_RATIO), SHEET_PEEK_H),
    fullH,
  );
  const fullOffset = 0;
  const halfOffset = fullH - halfH;
  const peekOffset = fullH - SHEET_PEEK_H;
  const sheetSnapRef = useRef<SheetSnap>("peek");
  // A reactive mirror of sheetSnapRef, for the two things that need a
  // RE-RENDER on snap change rather than an imperative read: the header's
  // accessibilityState (a screen reader has no other way to learn whether
  // activating it will open or close the sheet) and hiding the list from
  // the accessibility tree while only the peek bar is visible on screen
  // (VoiceOver ignores clipsToBounds, so without this a swipe-navigating
  // manager would walk into dozens of punch rows that show nothing).
  const [currentSnap, setCurrentSnap] = useState<SheetSnap>("peek");
  // Lazily-initialized state, not useRef().current: the instance is created
  // once and reading state during render is legal where reading a ref is not.
  //
  // Every animation on sheetY runs on the JS thread (useNativeDriver:false,
  // below). The point is that onPanResponderGrant can read the sheet's
  // CURRENT position synchronously, on the same thread the gesture arrives
  // on. A native-driven value cannot: its JS-side value refreshes only from
  // asynchronous onAnimatedValueUpdate events, which under the New
  // Architecture (Expo SDK 54 turns it on) do not reliably land before a
  // fresh grant reads them. That staleness is what snapped the sheet back to
  // its opening position on every second gesture on device — the drag seeded
  // from the peek value setValue wrote at mount, not the half/full the sheet
  // had since sprung to. A single translateY on one panel is cheap on the JS
  // thread (the list rows do not re-render as it slides), so running it there
  // buys a synchronously-readable position for no real smoothness cost.
  const [sheetY] = useState(() => new Animated.Value(0));
  const sheetGeo = useRef({ fullOffset: 0, halfOffset: 0, peekOffset: 0 });
  useEffect(() => {
    sheetGeo.current = { fullOffset, halfOffset, peekOffset };
  }, [fullOffset, halfOffset, peekOffset]);

  const offsetFor = useCallback((snap: SheetSnap) => {
    const g = sheetGeo.current;
    return snap === "peek" ? g.peekOffset : snap === "half" ? g.halfOffset : g.fullOffset;
  }, []);

  const snapSheet = useCallback(
    (snap: SheetSnap, animated = true) => {
      sheetSnapRef.current = snap;
      setCurrentSnap(snap);
      const to = offsetFor(snap);
      if (animated) {
        Animated.spring(sheetY, {
          toValue: to,
          useNativeDriver: false,
          friction: 10,
          tension: 70,
        }).start();
      } else {
        sheetY.setValue(to);
      }
    },
    [sheetY, offsetFor],
  );

  // The map's height arrives after first layout (and changes on rotation).
  // Re-seat the sheet at its current snap without animating, so it never
  // drifts to a stale offset.
  useEffect(() => {
    snapSheet(sheetSnapRef.current, false);
  }, [fullOffset, halfOffset, peekOffset, snapSheet]);

  const sheetDragBase = useRef(0);
  // Lazy state for the same reason as sheetY: one stable responder whose
  // handlers read live values through refs. The lint rule flags the ref
  // names inside the initializer, but they are only ever READ inside the
  // gesture callbacks, at event time — never during render.
  // eslint-disable-next-line react-hooks/refs
  const [sheetResponder] = useState(() =>
    PanResponder.create({
      // A tap must reach the peek bar's Pressable; only a real drag claims.
      onStartShouldSetPanResponder: () => false,
      onMoveShouldSetPanResponder: (_e, gs) => Math.abs(gs.dy) > 6,
      onPanResponderGrant: () => {
        // Seed the drag from the sheet's CURRENT position, halting any spring
        // still in flight. sheetY is JS-driven, so stopAnimation's callback
        // runs SYNCHRONOUSLY with the exact value the sheet sits at right now
        // (RN calls it inline for a non-native value; for a native value it
        // would be an async native round-trip that lands after the first
        // move events, which would then drag from a stale base). This is the
        // whole fix for both faults: the snap-back-to-peek reset (base was
        // the mount-time value, not where the sheet had sprung to) and a grab
        // that interrupts a spring mid-flight (base is where the finger is,
        // not the spring's target). offsetFor(sheetSnapRef.current) would be
        // that target — wrong for a mid-flight grab.
        sheetY.stopAnimation((v) => {
          sheetDragBase.current = v;
        });
      },
      onPanResponderMove: (_e, gs) => {
        const min = sheetGeo.current.fullOffset;
        const max = sheetGeo.current.peekOffset;
        const y = Math.min(Math.max(sheetDragBase.current + gs.dy, min), max);
        sheetY.setValue(y);
      },
      onPanResponderRelease: (_e, gs) => {
        const { fullOffset: full, halfOffset: half, peekOffset: peek } =
          sheetGeo.current;
        // Where the finger left it, nudged by the fling direction.
        const y = Math.min(Math.max(sheetDragBase.current + gs.dy + gs.vy * 120, full), peek);
        // Nearest of the three snaps, by distance — not a fixed midpoint,
        // since half can sit anywhere between full and peek depending on
        // the map's own height.
        const snap: SheetSnap =
          Math.abs(y - full) <= Math.abs(y - half) &&
          Math.abs(y - full) <= Math.abs(y - peek)
            ? "full"
            : Math.abs(y - half) <= Math.abs(y - peek)
              ? "half"
              : "peek";
        sheetSnapRef.current = snap;
        setCurrentSnap(snap);
        Animated.spring(sheetY, {
          toValue: snap === "full" ? full : snap === "half" ? half : peek,
          useNativeDriver: false,
          friction: 10,
          tension: 70,
        }).start();
      },
      onPanResponderTerminate: () => {
        // Something else claimed the gesture; settle back to the last snap.
        Animated.spring(sheetY, {
          toValue: offsetFor(sheetSnapRef.current),
          useNativeDriver: false,
          friction: 10,
          tension: 70,
        }).start();
      },
    }),
  );

  // Worksite labels, once per data load: the payload already carries the
  // worksites, and a punch belongs to the nearest one whose radius contains
  // it — the same rule the web sidebar applies server-side.
  const worksiteNameById = useMemo(() => {
    const out = new Map<string, string>();
    if (!data) return out;
    for (const p of data.punches) {
      let best = Number.POSITIVE_INFINITY;
      let name: string | null = null;
      for (const w of data.worksites) {
        const d = metresApart(
          p.clockInLatitude,
          p.clockInLongitude,
          w.latitude,
          w.longitude,
        );
        if (d <= w.radiusM && d < best) {
          best = d;
          name = w.name;
        }
      }
      if (name) out.set(p.id, name);
    }
    return out;
  }, [data]);

  // The sheet's list: ON THE CLOCK first (longest-running on top), then
  // completed punches newest first, under day headers when the range spans
  // more than one day — mirroring the web sidebar. Day boundaries are drawn
  // in the ORG's timeZone (see dayKeyInZone above), matching how the server
  // resolved the range in the first place.
  const orgTz = data?.timeZone;
  const sheetList = useMemo(() => {
    const onClock = visiblePunches
      .filter((p) => p.clockOutMs == null)
      .sort((a, b) => a.clockInMs - b.clockInMs);
    const done = visiblePunches
      .filter((p) => p.clockOutMs != null)
      .sort((a, b) => b.clockInMs - a.clockInMs);
    const dayKeys = new Set(
      visiblePunches.map((p) => dayKeyInZone(p.clockInMs, orgTz)),
    );
    return { onClock, done, groupByDay: dayKeys.size > 1 };
  }, [visiblePunches, orgTz]);

  // Row positions inside the sheet's scroll content, for scroll-into-view
  // when a pin tap selects a row. The list renders FLAT (headers and rows as
  // siblings) so each onLayout y is content-relative.
  const rowYs = useRef(new Map<string, number>());
  const sheetScrollRef = useRef<ScrollView | null>(null);
  // The sheet header's native view, plus whether a screen reader is
  // running — a row activation collapses the sheet to peek, which yanks
  // the focused row out of the accessibility tree, and without a hand-off
  // VoiceOver/TalkBack restart navigation from an arbitrary element. The
  // header is the one part of the sheet that survives the collapse, so
  // focus parks there. Tracked as a ref (not state): read only inside the
  // tap callback, and a screen-reader toggle must not re-render the map.
  const sheetHeadRef = useRef<View | null>(null);
  const screenReaderOn = useRef(false);
  useEffect(() => {
    let mounted = true;
    AccessibilityInfo.isScreenReaderEnabled().then((v) => {
      if (mounted) screenReaderOn.current = v;
    });
    const sub = AccessibilityInfo.addEventListener(
      "screenReaderChanged",
      (v) => {
        screenReaderOn.current = v;
      },
    );
    return () => {
      mounted = false;
      sub.remove();
    };
  }, []);

  const onRowPress = useCallback(
    (p: { id: string; clockInLatitude: number; clockInLongitude: number }) => {
      setSelectedPunchId(p.id);
      mapRef.current?.animateToRegion(
        {
          latitude: p.clockInLatitude,
          longitude: p.clockInLongitude,
          latitudeDelta: FAN_MAX_SPAN_LAT / 3,
          longitudeDelta: FAN_MAX_SPAN_LAT / 3,
        },
        350,
      );
      // Drop to the peek bar so the map (and the pin) is visible.
      snapSheet("peek");
      // Hand screen-reader focus to the header before the collapse hides
      // the activated row from the accessibility tree (see sheetHeadRef).
      // A beat's delay lets the tree apply the hide first.
      if (screenReaderOn.current) {
        setTimeout(() => {
          const head = sheetHeadRef.current;
          const tag = head ? findNodeHandle(head) : null;
          if (tag != null) AccessibilityInfo.setAccessibilityFocus(tag);
        }, 100);
      }

      // Open the callout once the fan has re-presented at the new span —
      // but POLL for the marker rather than waiting on a region-change
      // event. Re-tapping the same row, or a second row whose punch shares
      // its exact coordinates (common on a shared kiosk), targets a region
      // the camera is already at: neither platform fires a settle event for
      // a no-op animateToRegion, so a settle-triggered open would silently
      // never run, and a naive "retry forever" would then pop the callout
      // open on some unrelated pan minutes later. The token below fixes
      // both: it lets a fresh tap cancel an in-flight poll instead of two
      // polls racing, and the bounded attempt count means an unreachable
      // marker (still clustered, or the punch left the visible set on a
      // reload that landed mid-poll) gives up cleanly instead of lingering.
      const token = ++calloutAttemptSeq.current;
      const tryOpen = (attempt: number) => {
        if (calloutAttemptSeq.current !== token) return; // superseded
        const marker = markerRefs.current.get(p.id);
        if (marker) {
          marker.showCallout?.();
          return;
        }
        if (attempt >= CALLOUT_MAX_ATTEMPTS) return; // gave the fan its chance
        setTimeout(() => tryOpen(attempt + 1), CALLOUT_RETRY_MS);
      };
      // The animate above takes ~350ms; give the settle and the fan pass a
      // moment to land before the first check.
      setTimeout(() => tryOpen(0), 380);
    },
    [snapSheet],
  );

  const onPinPress = useCallback((id: string) => {
    // A pin tap supersedes any row tap still polling to open its callout —
    // the platform opens THIS pin's callout natively, and without the bump
    // the older poll's next tick would replace it with the stale punch's a
    // beat later, contradicting the selection the user just made.
    calloutAttemptSeq.current++;
    setSelectedPunchId(id);
    // While the sheet is open (half or full), reveal the row the pin just
    // selected. At the peek snap the native callout is the response; the
    // row is highlighted whenever the sheet next opens.
    if (sheetSnapRef.current !== "peek") {
      const y = rowYs.current.get(id);
      if (y != null) {
        sheetScrollRef.current?.scrollTo({
          y: Math.max(y - 8, 0),
          animated: true,
        });
      }
    }
  }, []);

  // Stable across renders so the memoized SheetRow's shallow compare can skip
  // rows that did not change (see SheetRow). rowYs is a ref, so writing it
  // here never triggers a render. Declared here, above the Maps early return,
  // to keep the hook order fixed.
  const onMeasureRowY = useCallback((id: string, y: number) => {
    rowYs.current.set(id, y);
  }, []);

  if (!Maps) {
    return (
      <View style={styles.fallback}>
        <Text style={styles.fallbackText}>
          The map needs the latest app build. Update Clox from the App Store or
          Play Store to see worksites and punches on a map.
        </Text>
      </View>
    );
  }

  const MapView = Maps.default;
  const { Marker, Circle, Callout } = Maps;

  // Both of these describe the RANGE as the server returned it, before the Who
  // filter narrowed the map. Left unqualified while a person is selected they
  // read as being about that person, which they are not.
  const noLocationLine =
    data && data.noLocationCount > 0
      ? `${data.noLocationCount} ${
          data.noLocationCount === 1 ? "punch" : "punches"
        } in this range ${
          data.noLocationCount === 1 ? "has" : "have"
        } no location${activeWhoId ? ", across the whole team" : ""}.`
      : null;

  const activeRangeText =
    range.fromKey === range.toKey
      ? rangeLabel(range.fromKey)
      : `${rangeLabel(range.fromKey)} to ${rangeLabel(range.toKey)}`;

  // The peek bar's one line: a quiet count, nothing else (§7b item 6 — the
  // bold range label already sits above the map, so repeating it here buys
  // nothing and just makes the peek bar loud). With the server cap hit and
  // no person filter, the plain count would read as the whole story; say
  // "First 400" the way the web sidebar does. A person filter shows that
  // person's subset, where the plain count is the honest one (the cap
  // banner below the map already carries the caveat).
  //
  // Built from visiblePunches — the currently LOADED data — never from the
  // target `range` state. A range switch updates `range` synchronously but
  // `data` only once the fetch resolves (load() deliberately keeps the old
  // data on screen during a reload); pairing this count with the fromKey a
  // manager just tapped, rather than the one the count actually describes,
  // would assert a false total for the seconds the fetch is in flight.
  const sheetCountLine =
    data?.truncated && !activeWhoId
      ? "First 400 located punches"
      : `${visiblePunches.length} located ${
          visiblePunches.length === 1 ? "punch" : "punches"
        }`;

  const renderSheetRow = (p: MapRangeData["punches"][number]) => (
    <SheetRow
      key={p.id}
      punch={p}
      site={worksiteNameById.get(p.id)}
      selected={selectedPunchId === p.id}
      orgTz={orgTz}
      onPress={onRowPress}
      onMeasureY={onMeasureRowY}
    />
  );

  return (
    <View style={styles.wrap}>
      <View style={styles.segment}>
        {(["day", "week", "month", "custom"] as const).map((m) => (
          <TouchableOpacity
            key={m}
            style={[styles.segmentBtn, mode === m && styles.segmentBtnOn]}
            onPress={() => {
              // Custom asks a question before it changes anything. Committing
              // the mode here and cancelling the sheet would drop the manager
              // on a today-only map with the Custom pill lit, having silently
              // thrown away the Week or Month they were looking at.
              if (m === "custom") {
                setCustomOpen(true);
                return;
              }
              setMode(m);
            }}
            activeOpacity={0.85}
            accessibilityRole="button"
            accessibilityState={{ selected: mode === m }}
          >
            <Text style={[styles.segmentText, mode === m && styles.segmentTextOn]}>
              {RANGE_LABELS[m]}
            </Text>
          </TouchableOpacity>
        ))}
      </View>

      {/* Help for the range control, mirroring the web worksites tour copy. */}
      <Text style={styles.rangeHelp}>
        Day, Week, Month, or Custom. The map shows the punches that happened
        inside it.
      </Text>

      {/* Whose punches. Only worth showing once more than one person has any:
          a one-person list is a control with no choice in it. */}
      {people.length > 1 ? (
        <View style={styles.whoWrap}>
          <SelectField
            label="Who"
            value={activeWhoId}
            options={people}
            placeholder="Everyone"
            noneLabel="Everyone"
            onSelect={setWhoId}
          />
        </View>
      ) : null}

      {/* Which range is actually on screen. A pill alone cannot say "Jul 1 to
          Jul 22", and Custom is meaningless without it. */}
      <Text style={styles.rangeActive}>{activeRangeText}</Text>

      <View
        style={styles.mapWrap}
        onLayout={(e) => setMapH(e.nativeEvent.layout.height)}
      >
        {region ? (
          <MapView
            ref={mapRef}
            style={StyleSheet.absoluteFill}
            initialRegion={region}
            showsUserLocation={false}
            toolbarEnabled={false}
            // Keeps the Google logo and Apple legal text above the sheet's
            // peek bar instead of underneath it.
            mapPadding={{ top: 0, right: 0, bottom: SHEET_PEEK_H, left: 0 }}
            // The settle updates viewSpan; the callout effect above consumes
            // any parked row-tap callout on the render that follows.
            onRegionChangeComplete={(r) => {
              // A settle away from the last cluster framing's centre means
              // the user panned; the next tap on that cluster should frame
              // it again rather than escalate. Our own animates settle ON
              // their requested centre (platform inflation widens only the
              // deltas), so they never trip this.
              const last = lastClusterZoom.current;
              if (
                last &&
                (Math.abs(r.latitude - last.latitude) >
                  last.latitudeDelta * 0.25 ||
                  Math.abs(r.longitude - last.longitude) >
                    last.longitudeDelta * 0.25)
              ) {
                lastClusterZoom.current = null;
              }
              setViewSpan(r.latitudeDelta);
            }}
            // The map is context; the punches are the content. These props do
            // NOT overlap: Android's MapManager.setMapType looks the string up
            // in a five-entry map with no "mutedStandard" key and unboxes the
            // null into an int, so passing the iOS value there is a hard
            // NullPointerException on every render. Each platform gets only
            // what it understands.
            {...(Platform.OS === "ios"
              ? {
                  mapType: "mutedStandard" as const,
                  // The rest of this screen is paper even when the phone is in
                  // dark mode; an unpinned MapView goes navy underneath it.
                  userInterfaceStyle: "light" as const,
                }
              : { customMapStyle: ANDROID_MUTED_STYLE })}
          >
            {data?.worksites.map((w) => (
              <Circle
                key={w.id}
                center={{ latitude: w.latitude, longitude: w.longitude }}
                radius={w.radiusM}
                strokeColor={c.accent}
                strokeWidth={1.5}
                fillColor="rgba(184,74,44,0.10)"
              />
            ))}
            {/* Groups seen from too far out to fan. One pin, the real
                count, and a tap that flies you in to where fanning tells the
                truth. */}
            {clusters.map((cl) => (
              <Marker
                key={cl.key}
                coordinate={{ latitude: cl.lat, longitude: cl.lng }}
                anchor={{ x: 0.5, y: 0.5 }}
                tracksViewChanges={trackMarkers}
                onPress={() => {
                  // A cluster tap supersedes any row tap still polling to
                  // open a callout: the camera is about to fly somewhere the
                  // poll never anticipated, and a callout popping open on
                  // the new framing a beat later reads as a glitch.
                  calloutAttemptSeq.current++;
                  // Frame the members' FULL extent, centred on the extent
                  // MIDPOINT — cl.midLat, never cl.lat: the mean hugs a
                  // skewed group's majority, and an extent-sized window
                  // centred there cuts the minority off screen (see
                  // PunchCluster). mid ± 0.7·span contains every member by
                  // construction, and platform aspect-fit inflation (iOS
                  // settles at up to ~2.2x the requested latitude span on a
                  // tall map) only widens the window further. An earlier
                  // revision instead capped the window at a fraction of the
                  // fan threshold to force fan mode; a window smaller than
                  // the group mounts members outside the viewport, and the
                  // manager watches a pin labeled "20" turn into an empty
                  // map.
                  //
                  // A group compact enough re-presents as a fan; one still
                  // too wide re-clusters into smaller groups at the tighter
                  // span. One shape does neither: a dense chain whose
                  // extent IS the current fit re-forms identically, the
                  // re-request equals the region the camera already sits
                  // at, no settle fires, and the pin would be dead forever.
                  // So a second tap on the exact same framing escalates to
                  // a fan-guaranteed window (0.4x threshold survives the
                  // ~2.2x inflation) on the group's middle; members outside
                  // it leave the screen until the manager pans, which is
                  // the honest price of zooming in.
                  const pad = 1.4;
                  let latDelta = Math.max(cl.spanLat * pad, 0.004);
                  let lngDelta = Math.max(cl.spanLng * pad, 0.004);
                  const last = lastClusterZoom.current;
                  if (
                    last &&
                    Math.abs(last.latitude - cl.midLat) < 1e-9 &&
                    Math.abs(last.longitude - cl.midLng) < 1e-9 &&
                    Math.abs(last.latitudeDelta - latDelta) < 1e-9 &&
                    Math.abs(last.longitudeDelta - lngDelta) < 1e-9
                  ) {
                    latDelta = FAN_MAX_SPAN_LAT * 0.4;
                    lngDelta = FAN_MAX_SPAN_LAT * 0.4;
                  }
                  const target = {
                    latitude: cl.midLat,
                    longitude: cl.midLng,
                    latitudeDelta: latDelta,
                    longitudeDelta: lngDelta,
                  };
                  lastClusterZoom.current = target;
                  mapRef.current?.animateToRegion(target, 300);
                }}
              >
                <View style={styles.clusterPin}>
                  <Text style={styles.clusterText}>{cl.members.length}</Text>
                </View>
              </Marker>
            ))}
            {fannedPunches.map((p) => {
              const onClock = p.clockOutMs == null;
              // An overnight shift ends on a different date than it started,
              // and "Out 3:08 AM" under "In 6:33 PM · Jul 8" reads as a
              // four-minute shift unless the day is said out loud.
              const outOnAnotherDay =
                p.clockOutMs != null &&
                shortDate(p.clockOutMs, orgTz) !== shortDate(p.clockInMs, orgTz);
              return (
                <Marker
                  key={p.id}
                  ref={(r) => {
                    if (r) markerRefs.current.set(p.id, r);
                    else markerRefs.current.delete(p.id);
                  }}
                  coordinate={{ latitude: p.fanLat, longitude: p.fanLng }}
                  anchor={{ x: 0.5, y: 0.5 }}
                  tracksViewChanges={trackMarkers}
                  onPress={() => onPinPress(p.id)}
                >
                  {onClock ? (
                    <View style={styles.initialsPin}>
                      <Text style={styles.initialsText}>
                        {initials(p.displayName)}
                      </Text>
                    </View>
                  ) : (
                    <View style={styles.punchDot} />
                  )}
                  <Callout tooltip={false}>
                    <View style={styles.callout}>
                      <Text style={styles.calloutName}>{p.displayName}</Text>
                      <Text style={styles.calloutLine}>
                        In {clock(p.clockInMs, orgTz)} ·{" "}
                        {shortDate(p.clockInMs, orgTz)}
                      </Text>
                      <Text style={styles.calloutLine}>
                        {p.clockOutMs != null
                          ? `Out ${clock(p.clockOutMs, orgTz)}${
                              outOnAnotherDay
                                ? ` · ${shortDate(p.clockOutMs, orgTz)}`
                                : ""
                            }`
                          : "Still on the clock"}
                      </Text>
                      {p.projectName ? (
                        <Text style={styles.calloutProject}>{p.projectName}</Text>
                      ) : null}
                    </View>
                  </Callout>
                </Marker>
              );
            })}
          </MapView>
        ) : (
          <View style={styles.center}>
            {loading ? (
              <ActivityIndicator color={c.accent} size="large" />
            ) : error ? (
              // There is no ScrollView behind this, so the old copy promised a
              // pull gesture the container could never receive. Offer the
              // button instead of the instruction.
              <>
                <Text style={styles.emptyText}>Couldn&apos;t load the map.</Text>
                <TouchableOpacity
                  style={styles.retry}
                  onPress={() => void load()}
                  accessibilityRole="button"
                >
                  <Text style={styles.retryText}>Try again</Text>
                </TouchableOpacity>
              </>
            ) : (
              <Text style={styles.emptyText}>
                No located punches or worksites in this range.
              </Text>
            )}
          </View>
        )}

        {loading && region ? (
          <View style={styles.loadingChip}>
            <ActivityIndicator color={c.accent} size="small" />
          </View>
        ) : null}

        {/* The linked punch list, as a bottom sheet over the map — the same
            list the web sidebar shows. Drag between peek, half, and a full
            extension that still leaves a map sliver visible; tap the header
            to toggle peek and half. The list scrolls inside the sheet; the
            map never moves with it.

            Two nested views on purpose: the OUTER carries the drop shadow
            (an iOS shadow renders from the view's true bounds, so it must
            not be clipped), the INNER carries the rounded corners and
            `overflow: hidden` that actually clips the header and list to
            them — putting both on one view would clip the shadow away. */}
        {region && mapH > 0 ? (
          <Animated.View
            style={[
              styles.sheetPanel,
              { height: fullH, transform: [{ translateY: sheetY }] },
            ]}
          >
            <View style={styles.sheetPanelInner}>
              <View {...sheetResponder.panHandlers}>
                <Pressable
                  ref={sheetHeadRef}
                  style={styles.sheetHead}
                  onPress={() =>
                    snapSheet(
                      sheetSnapRef.current === "peek" ? "half" : "peek",
                    )
                  }
                  accessibilityRole="button"
                  accessibilityLabel={`Punch list. ${sheetCountLine}`}
                  accessibilityHint="Opens and closes the list of punches on the map."
                  accessibilityState={{ expanded: currentSnap !== "peek" }}
                >
                  <View style={styles.sheetGrabBar} />
                  <Text style={styles.sheetCountLine} numberOfLines={1}>
                    {sheetCountLine}
                  </Text>
                </Pressable>
              </View>
              <ScrollView
                ref={sheetScrollRef}
                style={styles.sheetListScroll}
                // The panel is fullH tall at every snap; at half, its bottom
                // halfOffset px hang below the fold, clipped by mapWrap — and
                // the ScrollView's max scroll offset aligns the content's end
                // with that HIDDEN bottom, which would leave the last
                // halfOffset px of rows unreachable no matter how far the
                // manager scrolls (and pin-tap scroll-into-view silently
                // short for rows near the end). Extra bottom padding equal to
                // the hidden band restores every row's reachability at half;
                // at full none is needed. Keyed to the resting snap: mid-drag
                // there is no second finger to scroll with, so the stale
                // value until release never bites.
                contentContainerStyle={[
                  styles.sheetListContent,
                  currentSnap !== "full"
                    ? { paddingBottom: 28 + halfOffset }
                    : null,
                ]}
                // At peek, the list still occupies its full laid-out height
                // offscreen below the visible bar — VoiceOver/TalkBack don't
                // know that, so without this a swipe-navigating user lands on
                // rows they can't see or reach.
                accessibilityElementsHidden={currentSnap === "peek"}
                importantForAccessibility={
                  currentSnap === "peek" ? "no-hide-descendants" : "auto"
                }
              >
                {visiblePunches.length === 0 ? (
                  <Text style={styles.sheetEmpty}>
                    No located punches in this range.
                  </Text>
                ) : null}
                {sheetList.onClock.length > 0 ? (
                  <Text style={styles.sheetKicker}>On the clock</Text>
                ) : null}
                {sheetList.onClock.map(renderSheetRow)}
                {sheetList.done.length > 0 && sheetList.onClock.length > 0 ? (
                  <Text style={styles.sheetKicker}>Punches</Text>
                ) : null}
              {/* sheetList.done is already sorted clockInMs descending (see
                  the sheetList useMemo above), so grouping by the day it
                  transitions to automatically yields days newest-first, and
                  the latest punch within each day first — no separate
                  ordering step needed here. */}
              {sheetList.groupByDay
                ? sheetList.done.flatMap((p, i) => {
                    const k = dayKeyInZone(p.clockInMs, orgTz);
                    const prev =
                      i > 0
                        ? dayKeyInZone(sheetList.done[i - 1]!.clockInMs, orgTz)
                        : null;
                    const nodes = [];
                    if (k !== prev) {
                      nodes.push(
                        <Text key={`day-${k}`} style={styles.sheetDayHead}>
                          {dayHeadingInZone(p.clockInMs, orgTz)}
                        </Text>,
                      );
                    }
                    nodes.push(renderSheetRow(p));
                    return nodes;
                  })
                : sheetList.done.map(renderSheetRow)}
              </ScrollView>
            </View>
          </Animated.View>
        ) : null}
      </View>

      {/* Verbatim from the web map. The old mobile wording said "most recent",
          which was false: the server orders by clock-in time ascending and
          keeps the FIRST 400. */}
      {data?.truncated ? (
        <Text style={styles.capBanner}>
          Showing the first 400 located punches in this range.{" "}
          {activeWhoId
            ? "That cap is counted across everyone, so some of this person's punches may be missing. "
            : ""}
          Narrow the range to see the rest.
        </Text>
      ) : null}
      {noLocationLine ? (
        <Text style={styles.noLocation}>{noLocationLine}</Text>
      ) : null}

      {/* Verbatim, mono — a persistent privacy assurance under the map. */}
      <Text style={styles.privacy}>{PRIVACY_CAPTION}</Text>

      {customOpen ? (
        <CustomRangeSheet
          key={`${range.fromKey}:${range.toKey}`}
          initial={range}
          onCancel={() => setCustomOpen(false)}
          onApply={(r) => {
            setCustom(r);
            setMode("custom");
            setCustomOpen(false);
          }}
        />
      ) : null}
    </View>
  );
}

const MONO = Platform.select({ ios: "Menlo", android: "monospace", default: "monospace" });

const styles = StyleSheet.create({
  wrap: { flex: 1 },
  segment: {
    flexDirection: "row",
    marginHorizontal: 24,
    marginTop: 4,
    padding: 3,
    backgroundColor: c.surfaceAlt,
    borderRadius: radii.md,
  },
  segmentBtn: {
    flex: 1,
    alignItems: "center",
    paddingVertical: 7,
    borderRadius: radii.sm,
  },
  segmentBtnOn: { backgroundColor: c.surface },
  segmentText: { color: c.textMuted, fontSize: 13, fontWeight: "600" },
  segmentTextOn: { color: c.text, fontWeight: "700" },
  rangeHelp: {
    color: c.textMuted,
    fontSize: 11,
    paddingHorizontal: 24,
    paddingTop: 8,
    lineHeight: 15,
  },
  mapWrap: {
    flex: 1,
    marginHorizontal: 24,
    marginTop: 10,
    borderRadius: radii.lg,
    overflow: "hidden",
    backgroundColor: c.surfaceAlt,
  },
  center: { flex: 1, alignItems: "center", justifyContent: "center", padding: 24 },
  emptyText: { color: c.textMuted, fontSize: 14, textAlign: "center" },
  loadingChip: {
    position: "absolute",
    top: 10,
    right: 10,
    backgroundColor: c.surface,
    borderRadius: radii.pill,
    padding: 8,
  },
  // Pins carry the meaning, so they get a paper ring and a shadow to lift them
  // off the basemap. c.accentText is the warm paper token the app already uses
  // for anything sitting on a colored fill.
  punchDot: {
    width: 18,
    height: 18,
    borderRadius: 9,
    backgroundColor: c.accent,
    borderWidth: 2.5,
    borderColor: c.accentText,
    shadowColor: "#000",
    shadowOpacity: 0.3,
    shadowRadius: 3,
    shadowOffset: { width: 0, height: 1 },
    elevation: 4,
  },
  initialsPin: {
    minWidth: 30,
    height: 30,
    borderRadius: 15,
    paddingHorizontal: 4,
    backgroundColor: c.success,
    borderWidth: 2.5,
    borderColor: c.accentText,
    alignItems: "center",
    justifyContent: "center",
    shadowColor: "#000",
    shadowOpacity: 0.3,
    shadowRadius: 3,
    shadowOffset: { width: 0, height: 1 },
    elevation: 4,
  },
  initialsText: { color: c.accentText, fontSize: 12, fontWeight: "800" },
  /** A counted group at cluster zoom. Same accent fill and paper ring as a
   *  single punch dot, so it reads as "these pins" rather than a new concept. */
  clusterPin: {
    minWidth: 28,
    height: 28,
    borderRadius: 14,
    paddingHorizontal: 6,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: c.accent,
    borderWidth: 2.5,
    borderColor: c.accentText,
    shadowColor: "#000",
    shadowOpacity: 0.25,
    shadowRadius: 3,
    shadowOffset: { width: 0, height: 1 },
    elevation: 3,
  },
  clusterText: { color: c.accentText, fontSize: 12, fontWeight: "700" },
  // Wide enough that a real worksite name ("Riverside Heights Rough-In") wraps
  // between words instead of splitting one.
  callout: { minWidth: 210, padding: 2 },
  calloutName: { color: c.text, fontSize: 14, fontWeight: "700", marginBottom: 2 },
  calloutLine: { color: c.text, fontSize: 12 },
  calloutProject: { color: c.textMuted, fontSize: 12, marginTop: 2 },
  capBanner: {
    color: c.warn,
    fontSize: 12,
    paddingHorizontal: 24,
    paddingTop: 8,
  },
  noLocation: {
    color: c.textMuted,
    fontSize: 12,
    paddingHorizontal: 24,
    paddingTop: 6,
  },
  privacy: {
    color: c.textMuted,
    fontSize: 11,
    fontFamily: MONO,
    paddingHorizontal: 24,
    paddingTop: 8,
    paddingBottom: 12,
  },
  fallback: { flex: 1, alignItems: "center", justifyContent: "center", padding: 32 },
  fallbackText: { color: c.textMuted, fontSize: 15, textAlign: "center", lineHeight: 22 },
  whoWrap: { paddingHorizontal: 24, paddingTop: 10 },
  rangeActive: {
    color: c.text,
    fontSize: 13,
    fontWeight: "700",
    paddingHorizontal: 24,
    paddingTop: 6,
  },
  retry: {
    marginTop: 12,
    borderWidth: 1,
    borderColor: c.border,
    borderRadius: radii.pill,
    paddingVertical: 8,
    paddingHorizontal: 18,
  },
  retryText: { color: c.text, fontSize: 14, fontWeight: "700" },
  // ── The punch-list bottom sheet over the map. Surface and hairline from
  //    the same light tokens as the rest of this screen (the map area stays
  //    paper in both phone palettes, so the sheet does too). The soft top
  //    shadow separates it from map imagery, the way native map sheets do.
  //
  //    sheetPanel (outer) carries only the iOS shadow; an iOS shadow
  //    renders from a view's true bounds, so IT must stay overflow:visible.
  //    sheetPanelInner carries the fill, the rounded corners, the top-edge
  //    hairline (on the SAME view as the radius, so the line curves with
  //    the corners instead of drawing straight whiskers over the map),
  //    `overflow: hidden` — the thing that actually clips the header and
  //    list to that shape — and the Android elevation: Android draws an
  //    elevation shadow from the view's background outline, so on the
  //    background-less outer view it casts nothing at all, while here it
  //    follows the rounded fill. One view doing all of it would clip the
  //    iOS shadow away along with the content.
  sheetPanel: {
    position: "absolute",
    left: 0,
    right: 0,
    bottom: 0,
    shadowColor: "#000",
    shadowOpacity: 0.15,
    shadowRadius: 8,
    shadowOffset: { width: 0, height: -2 },
  },
  sheetPanelInner: {
    flex: 1,
    backgroundColor: c.surface,
    borderTopLeftRadius: radii.lg,
    borderTopRightRadius: radii.lg,
    borderTopWidth: 1,
    borderColor: c.border,
    overflow: "hidden",
    elevation: 8,
  },
  sheetHead: {
    height: SHEET_PEEK_H,
    alignItems: "center",
    paddingTop: 8,
    paddingHorizontal: 16,
    backgroundColor: c.surface,
    borderBottomWidth: 1,
    borderBottomColor: c.border,
  },
  sheetGrabBar: {
    width: 36,
    height: 4,
    borderRadius: 999,
    backgroundColor: c.border,
    marginBottom: 8,
  },
  sheetCountLine: {
    fontFamily: MONO,
    fontSize: 11,
    fontWeight: "600",
    letterSpacing: 1.2,
    textTransform: "uppercase",
    color: c.textMuted,
  },
  sheetListScroll: { flex: 1 },
  // paddingBottom well past the last row's own line height so the bottom
  // line of a long meta line never touches the sheet's edge (§7b item 2:
  // 12 left it cut mid-glyph at the half snap). paddingTop is a small
  // breathing gap under the header's new hairline, not a reserved section.
  sheetListContent: { paddingHorizontal: 10, paddingTop: 4, paddingBottom: 28 },
  sheetEmpty: {
    color: c.textMuted,
    fontSize: 13,
    paddingHorizontal: 6,
    paddingTop: 8,
  },
  sheetKicker: {
    fontFamily: MONO,
    fontSize: 10.5,
    fontWeight: "600",
    letterSpacing: 1.2,
    textTransform: "uppercase",
    color: c.textMuted,
    paddingHorizontal: 6,
    paddingTop: 10,
    paddingBottom: 4,
  },
  sheetDayHead: {
    fontFamily: MONO,
    fontSize: 10.5,
    fontWeight: "600",
    letterSpacing: 1,
    textTransform: "uppercase",
    color: c.textMuted,
    paddingHorizontal: 6,
    paddingTop: 10,
    paddingBottom: 4,
  },
  sheetRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
    paddingVertical: 9,
    paddingHorizontal: 8,
    borderRadius: radii.md,
    borderWidth: 1,
    borderColor: "transparent",
  },
  // Selected: the clay wash with a full border, matching the web sidebar.
  sheetRowSelected: {
    backgroundColor: "rgba(184, 74, 44, 0.10)",
    borderColor: c.accent,
  },
  sheetDisc: {
    width: 22,
    height: 22,
    borderRadius: 11,
    alignItems: "center",
    justifyContent: "center",
  },
  sheetDiscOn: { backgroundColor: c.success },
  sheetDiscDone: { backgroundColor: c.accent },
  sheetDiscText: { color: c.accentText, fontSize: 10, fontWeight: "700" },
  sheetRowBody: { flex: 1, minWidth: 0 },
  sheetRowName: { color: c.text, fontSize: 14, fontWeight: "600" },
  sheetRowMeta: {
    color: c.textMuted,
    fontSize: 12,
    lineHeight: 16,
    marginTop: 2,
  },
  sheetRowProjectLine: {
    flexDirection: "row",
    alignItems: "center",
    gap: 5,
    marginTop: 2,
  },
  sheetProjectDot: { width: 7, height: 7, borderRadius: 3.5 },
  sheetRowProject: { color: c.textMuted, fontSize: 12, flexShrink: 1 },
  backdrop: { flex: 1, backgroundColor: scrim, justifyContent: "flex-end" },
  sheet: {
    backgroundColor: c.bg,
    borderTopLeftRadius: 20,
    borderTopRightRadius: 20,
    paddingTop: 18,
    paddingBottom: 24,
  },
  sheetTitle: {
    color: c.text,
    fontSize: 20,
    fontWeight: "800",
    paddingHorizontal: 20,
    marginBottom: 8,
  },
  sheetBody: { paddingHorizontal: 20, paddingTop: 4 },
  fieldLabel: {
    color: c.textMuted,
    fontSize: 13,
    fontWeight: "600",
    marginBottom: 6,
  },
  iosPicker: { alignSelf: "flex-start", marginLeft: -10 },
  fieldBtn: {
    borderWidth: 1,
    borderColor: c.border,
    borderRadius: radii.md,
    backgroundColor: c.surface,
    paddingVertical: 12,
    paddingHorizontal: 14,
  },
  fieldValue: { color: c.text, fontSize: 16, fontWeight: "600" },
  sheetActions: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingHorizontal: 20,
    paddingTop: 18,
  },
  cancel: { color: c.textMuted, fontSize: 16, fontWeight: "600" },
  apply: {
    backgroundColor: c.accent,
    borderRadius: 14,
    paddingVertical: 14,
    paddingHorizontal: 28,
    alignItems: "center",
  },
  applyText: { color: c.accentText, fontSize: 16, fontWeight: "700" },
});
