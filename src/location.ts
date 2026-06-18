import * as Location from "expo-location";

export type Coords = {
  latitude: number | null;
  longitude: number | null;
  accuracyM: number | null;
};

const EMPTY: Coords = { latitude: null, longitude: null, accuracyM: null };

/**
 * Best-effort current location for a punch. Asks permission the first time; if
 * it's denied or the fix fails, returns nulls and lets the punch proceed —
 * clocking in must never be blocked by location in this MVP (server-side
 * geofence *enforcement* is a later feature; here we just capture coordinates).
 */
export async function getPunchLocation(): Promise<Coords> {
  try {
    const { status } = await Location.requestForegroundPermissionsAsync();
    if (status !== "granted") return EMPTY;
    const pos = await Location.getCurrentPositionAsync({
      accuracy: Location.Accuracy.Balanced,
    });
    return {
      latitude: pos.coords.latitude,
      longitude: pos.coords.longitude,
      accuracyM: pos.coords.accuracy ?? null,
    };
  } catch {
    return EMPTY;
  }
}
