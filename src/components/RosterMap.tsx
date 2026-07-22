import { useCallback, useMemo, useState } from "react";
import {
  ActivityIndicator,
  Platform,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from "react-native";
import { useFocusEffect } from "@react-navigation/native";
import type { Region } from "react-native-maps";

import { getManagerMapRange, type MapRangeData } from "../api";
import { getAccessToken } from "../supabase";
import { lightColors as c, radii } from "../theme";

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

function computeRange(mode: RangeMode): { fromKey: string; toKey: string } {
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
  // day + custom(v1: today) both resolve to today.
  const k = dayKey(today);
  return { fromKey: k, toKey: k };
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

export function RosterMap() {
  const Maps = useMemo(() => loadMaps(), []);
  const [mode, setMode] = useState<RangeMode>("day");
  const [data, setData] = useState<MapRangeData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);

  const range = useMemo(() => computeRange(mode), [mode]);

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
            onPress={() => setMode(m)}
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

      <View style={styles.mapWrap}>
        {region ? (
          <MapView
            style={StyleSheet.absoluteFill}
            initialRegion={region}
            region={region}
            showsUserLocation={false}
            toolbarEnabled={false}
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
            {data?.punches.map((p) => {
              const onClock = p.clockOutMs == null;
              return (
                <Marker
                  key={p.id}
                  coordinate={{
                    latitude: p.clockInLatitude,
                    longitude: p.clockInLongitude,
                  }}
                  anchor={{ x: 0.5, y: 0.5 }}
                  tracksViewChanges={false}
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
                          ? `Out ${clock(p.clockOutMs)}`
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
              <Text style={styles.emptyText}>
                Couldn&apos;t load the map. Pull to try again.
              </Text>
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

      {data?.truncated ? (
        <Text style={styles.capBanner}>
          Showing the most recent 400 pins for this range.
        </Text>
      ) : null}
      {noLocationLine ? (
        <Text style={styles.noLocation}>{noLocationLine}</Text>
      ) : null}

      {/* Verbatim, mono — a persistent privacy assurance under the map. */}
      <Text style={styles.privacy}>{PRIVACY_CAPTION}</Text>
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
  punchDot: {
    width: 14,
    height: 14,
    borderRadius: 7,
    backgroundColor: c.accent,
    borderWidth: 2,
    borderColor: c.accentText,
  },
  initialsPin: {
    minWidth: 28,
    height: 28,
    borderRadius: 14,
    paddingHorizontal: 4,
    backgroundColor: c.success,
    borderWidth: 2,
    borderColor: c.accentText,
    alignItems: "center",
    justifyContent: "center",
  },
  initialsText: { color: c.accentText, fontSize: 12, fontWeight: "800" },
  callout: { minWidth: 150, padding: 2 },
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
});
