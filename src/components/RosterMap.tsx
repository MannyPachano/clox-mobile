import { useCallback, useEffect, useMemo, useState } from "react";
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

import { getManagerMapRange, type MapRangeData } from "../api";
import { getAccessToken } from "../supabase";
import { lightColors as c, radii, scrim } from "../theme";

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

/**
 * Spread punches that share a spot so each one stays its own tappable pin.
 *
 * Two people clocking in at the same trailer land on identical coordinates, and
 * an on-shift avatar drawn over a completed dot reads as one broken pin rather
 * than two workers. Punches are bucketed by their coordinates rounded to four
 * decimals (about 11m, which is inside any worksite) and each bucket's members
 * are pushed out around a small circle. The offsets are metres, so the fan
 * holds its shape at worksite zoom instead of scaling with latitude.
 */
function fanColocated<T extends { clockInLatitude: number; clockInLongitude: number }>(
  punches: T[],
): (T & { fanLat: number; fanLng: number })[] {
  const buckets = new Map<string, T[]>();
  for (const p of punches) {
    const key = `${p.clockInLatitude.toFixed(4)},${p.clockInLongitude.toFixed(4)}`;
    const arr = buckets.get(key);
    if (arr) arr.push(p);
    else buckets.set(key, [p]);
  }

  const out: (T & { fanLat: number; fanLng: number })[] = [];
  for (const group of buckets.values()) {
    if (group.length === 1) {
      const only = group[0]!;
      out.push({
        ...only,
        fanLat: only.clockInLatitude,
        fanLng: only.clockInLongitude,
      });
      continue;
    }
    group.forEach((p, i) => {
      const angle = (2 * Math.PI * i) / group.length;
      const radiusM = 8 + (i % 4) * 2; // 8, 10, 12, 14
      const dLat = (radiusM * Math.cos(angle)) / M_PER_DEG_LAT;
      const lngScale =
        M_PER_DEG_LAT * Math.max(0.15, Math.cos((p.clockInLatitude * Math.PI) / 180));
      const dLng = (radiusM * Math.sin(angle)) / lngScale;
      out.push({
        ...p,
        fanLat: p.clockInLatitude + dLat,
        fanLng: p.clockInLongitude + dLng,
      });
    });
  }
  return out;
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
      if (res.ok) setData(res.data);
      else setError(true);
    } catch {
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
  const fannedPunches = useMemo(
    () => (data ? fanColocated(data.punches) : []),
    [data],
  );

  // Re-enable marker snapshotting when the pins change, then turn it off after
  // they've painted so scroll/zoom stays cheap.
  useEffect(() => {
    setTrackMarkers(true);
    const id = setTimeout(() => setTrackMarkers(false), 1500);
    return () => clearTimeout(id);
  }, [data]);

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

  const noLocationLine =
    data && data.noLocationCount > 0
      ? `${data.noLocationCount} ${
          data.noLocationCount === 1 ? "punch" : "punches"
        } in this range ${data.noLocationCount === 1 ? "has" : "have"} no location.`
      : null;

  return (
    <View style={styles.wrap}>
      <View style={styles.segment}>
        {(["day", "week", "month", "custom"] as const).map((m) => (
          <TouchableOpacity
            key={m}
            style={[styles.segmentBtn, mode === m && styles.segmentBtnOn]}
            onPress={() => {
              setMode(m);
              // Custom is a control, not just a label: tapping it asks which
              // range, and tapping it again lets you change your answer.
              if (m === "custom") setCustomOpen(true);
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
            style={StyleSheet.absoluteFill}
            initialRegion={region}
            showsUserLocation={false}
            toolbarEnabled={false}
            // The map is context; the punches are the content. Muted on iOS,
            // and pinned to light because the rest of this screen is paper
            // even when the phone is in dark mode: an unpinned MapView goes
            // navy underneath a light UI.
            mapType="mutedStandard"
            userInterfaceStyle="light"
            customMapStyle={ANDROID_MUTED_STYLE}
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
          Showing the first 400 located punches in this range. Narrow the range
          to see the rest.
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
