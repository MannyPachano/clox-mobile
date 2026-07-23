import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  ActivityIndicator,
  Modal,
  Platform,
  Pressable,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from "react-native";
import { useFocusEffect } from "@react-navigation/native";
import DateTimePicker from "@react-native-community/datetimepicker";
import type { Region } from "react-native-maps";

import { getManagerMapRange, type MapRangeData, type Option } from "../api";
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
  lat: number;
  lng: number;
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
      clusters.push({
        key: `cluster-${lat.toFixed(5)},${lng.toFixed(5)}-${group.length}`,
        lat,
        lng,
        spanLat: Math.max(...lats) - Math.min(...lats),
        spanLng: Math.max(...lngs) - Math.min(...lngs),
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

function clock(ms: number): string {
  const d = new Date(ms);
  let h = d.getHours();
  const m = d.getMinutes();
  const ampm = h >= 12 ? "PM" : "AM";
  h = h % 12 || 12;
  return `${h}:${pad(m)} ${ampm}`;
}

function shortDate(ms: number): string {
  const d = new Date(ms);
  const M = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  return `${M[d.getMonth()]} ${d.getDate()}`;
}

function initials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return "?";
  if (parts.length === 1) return parts[0]!.slice(0, 2).toUpperCase();
  return (parts[0]![0]! + parts[parts.length - 1]![0]!).toUpperCase();
}

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
      <Text style={styles.rangeActive}>
        {range.fromKey === range.toKey
          ? rangeLabel(range.fromKey)
          : `${rangeLabel(range.fromKey)} to ${rangeLabel(range.toKey)}`}
      </Text>

      <View style={styles.mapWrap}>
        {region ? (
          <MapView
            ref={mapRef}
            style={StyleSheet.absoluteFill}
            initialRegion={region}
            showsUserLocation={false}
            toolbarEnabled={false}
            onRegionChangeComplete={(r) => setViewSpan(r.latitudeDelta)}
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
                  // Frame the members, not a fixed box around their centre: a
                  // chained group can be far wider than any constant, and its
                  // centroid is not where anybody clocked in. Capped just under
                  // the cluster threshold so the tap always lands in fan mode;
                  // a group too wide to fit simply breaks into smaller
                  // clusters, which is the next tap.
                  const pad = 1.4;
                  const latDelta = Math.min(
                    FAN_MAX_SPAN_LAT * 0.9,
                    Math.max(cl.spanLat * pad, 0.004),
                  );
                  const lngDelta = Math.min(
                    FAN_MAX_SPAN_LAT * 0.9,
                    Math.max(cl.spanLng * pad, 0.004),
                  );
                  mapRef.current?.animateToRegion(
                    {
                      latitude: cl.lat,
                      longitude: cl.lng,
                      latitudeDelta: latDelta,
                      longitudeDelta: lngDelta,
                    },
                    300,
                  );
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
                shortDate(p.clockOutMs) !== shortDate(p.clockInMs);
              return (
                <Marker
                  key={p.id}
                  coordinate={{ latitude: p.fanLat, longitude: p.fanLng }}
                  anchor={{ x: 0.5, y: 0.5 }}
                  tracksViewChanges={trackMarkers}
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
                        In {clock(p.clockInMs)} · {shortDate(p.clockInMs)}
                      </Text>
                      <Text style={styles.calloutLine}>
                        {p.clockOutMs != null
                          ? `Out ${clock(p.clockOutMs)}${
                              outOnAnotherDay
                                ? ` · ${shortDate(p.clockOutMs)}`
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
