export type Fence = { latitude: number; longitude: number; radiusM: number };

function toRad(d: number): number {
  return (d * Math.PI) / 180;
}

/** Haversine distance in metres (WGS84 sphere), matching the server. */
function distanceMeters(
  lat1: number,
  lng1: number,
  lat2: number,
  lng2: number,
): number {
  const R = 6_371_000;
  const dLat = toRad(lat2 - lat1);
  const dLng = toRad(lng2 - lng1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

/** Accuracy credited toward the fence, capped — mirrors the server. */
const ACCURACY_GRACE_CAP_M = 100;
/** Above max(this, widest fence) the server rejects a fix as too coarse to
 *  trust (geo_inaccurate). Kept in step with the server's MIN_ACCURACY_REJECT_M
 *  so the advisory predicts the same rejection. */
const MIN_ACCURACY_REJECT_M = 500;

export type PrecheckResult = "ok" | "no_location" | "off_site" | "inaccurate";

/**
 * Client-side ADVISORY geofence check, mirroring the server's distance +
 * accuracy-grace math. Its only job is to warn a worker at clock-in time,
 * chiefly when offline, so a punch the server will reject isn't discovered only
 * after they've left the site. The server re-checks every punch and is the
 * authority; a stale or missing fence here never blocks a clock-in.
 */
export function precheckGeofence(
  coords: {
    latitude: number | null;
    longitude: number | null;
    accuracyM: number | null;
  },
  fences: Fence[],
): PrecheckResult {
  if (fences.length === 0) return "ok";
  if (coords.latitude == null || coords.longitude == null) return "no_location";
  // Mirror the server's coarse-fix rejection (geo_inaccurate) before distance,
  // so an offline worker with a weak fix is warned rather than dropped on sync.
  if (coords.accuracyM != null && Number.isFinite(coords.accuracyM)) {
    const maxRadius = fences.reduce((m, f) => Math.max(m, f.radiusM), 0);
    if (coords.accuracyM > Math.max(MIN_ACCURACY_REJECT_M, maxRadius)) {
      return "inaccurate";
    }
  }
  const grace =
    coords.accuracyM != null && Number.isFinite(coords.accuracyM)
      ? Math.min(coords.accuracyM, ACCURACY_GRACE_CAP_M)
      : 0;
  for (const f of fences) {
    if (
      distanceMeters(
        coords.latitude,
        coords.longitude,
        f.latitude,
        f.longitude,
      ) <=
      f.radiusM + grace
    ) {
      return "ok";
    }
  }
  return "off_site";
}
