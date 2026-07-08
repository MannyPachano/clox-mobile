import * as Location from "expo-location";

export type Coords = {
  latitude: number | null;
  longitude: number | null;
  accuracyM: number | null;
  /** Android only: the OS reports this fix came from a mock provider (a
   *  "fake GPS" app). `null` when unknown (iOS never reports it). The server
   *  flags a mocked geofenced punch for a manager and signs it into the proof
   *  record; it is a deterrent, not a guarantee. */
  mocked: boolean | null;
};

const EMPTY: Coords = {
  latitude: null,
  longitude: null,
  accuracyM: null,
  mocked: null,
};

/** Give a slow satellite lock this long before falling back to a cached fix,
 *  so a worker who taps once is never left waiting on the GPS. */
const FIX_TIMEOUT_MS = 8_000;
/** Accept a recent cached fix (last known position) up to this old. */
const LAST_KNOWN_MAX_AGE_MS = 60_000;

function fromPosition(pos: Location.LocationObject): Coords {
  return {
    latitude: pos.coords.latitude,
    longitude: pos.coords.longitude,
    accuracyM: pos.coords.accuracy ?? null,
    // `mocked` is a top-level field on the fix, Android-only; undefined on iOS.
    mocked: pos.mocked ?? null,
  };
}

/**
 * Best-effort current location for a punch. Asks permission the first time; if
 * it's denied or the fix fails, returns nulls and lets the punch proceed. The
 * server is the authority on the geofence, so the phone's job is only to
 * capture the best fix it reasonably can without making the worker wait:
 *
 *  1. Ask for a fresh HIGH-accuracy fix (tighter than the old Balanced read, so
 *     honest punches near a fence edge aren't falsely flagged low-accuracy).
 *  2. Race it against an 8s timeout so a weak indoor signal never hangs the tap.
 *  3. On timeout, fall back to the most recent cached fix; only then give up.
 *
 * We also capture the device mock-location flag so the server can flag a
 * spoofed punch.
 */
/**
 * Spin up the GPS and populate the last-known cache ahead of a punch, so the
 * FIRST clock-in after opening the app doesn't wait on a cold satellite lock.
 * Best-effort and silent: it only runs when permission is ALREADY granted (it
 * never prompts here — the punch itself still asks if needed), and any failure
 * is ignored. Balanced accuracy is enough to warm the chip and seed a fix that
 * getPunchLocation can fall back to; the punch still asks for a High fix.
 */
export async function warmUpLocation(): Promise<void> {
  try {
    const { status } = await Location.getForegroundPermissionsAsync();
    if (status !== "granted") return;
    await Location.getCurrentPositionAsync({
      accuracy: Location.Accuracy.Balanced,
    });
  } catch {
    // Warm-up is purely an optimization — never surface or throw.
  }
}

export async function getPunchLocation(): Promise<Coords> {
  try {
    const { status } = await Location.requestForegroundPermissionsAsync();
    if (status !== "granted") return EMPTY;

    const fresh = await Promise.race([
      Location.getCurrentPositionAsync({ accuracy: Location.Accuracy.High }),
      new Promise<null>((resolve) =>
        setTimeout(() => resolve(null), FIX_TIMEOUT_MS),
      ),
    ]);
    if (fresh) return fromPosition(fresh);

    const lastKnown = await Location.getLastKnownPositionAsync({
      maxAge: LAST_KNOWN_MAX_AGE_MS,
    });
    return lastKnown ? fromPosition(lastKnown) : EMPTY;
  } catch {
    return EMPTY;
  }
}
