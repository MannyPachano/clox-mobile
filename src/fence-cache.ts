import AsyncStorage from "@react-native-async-storage/async-storage";

import type { Fence } from "./geofence";

/**
 * The worksite fences from the last successful getStatus, kept on disk so the
 * offline clock-in warning (precheckGeofence in ClockScreen's doClockIn) works
 * after a cold start with no signal. Without it the fences lived only in React
 * state, so an app opened fresh in a dead zone had none and never warned; the
 * punch was still queued and the server refused it at sync, with no heads-up.
 *
 * Same shape of trust as boot-snapshot.ts: the owner's user id is stored with
 * the fences and a read only returns them for that same user, so one person's
 * worksites are never used for another's warning. App.tsx also clears it on
 * sign-out, on re-authentication, and when a different user signs in.
 *
 * The warning stays advisory and fail-open: a missing, stale or unreadable
 * cache means no warning, never a blocked clock-in. The server re-checks every
 * punch and is the authority.
 */
const KEY = "clox.fences.v1";

type Stored = { userId: string; fences: Fence[] };

function isFence(v: unknown): v is Fence {
  if (!v || typeof v !== "object") return false;
  const f = v as Record<string, unknown>;
  return (
    typeof f.latitude === "number" &&
    Number.isFinite(f.latitude) &&
    f.latitude >= -90 &&
    f.latitude <= 90 &&
    typeof f.longitude === "number" &&
    Number.isFinite(f.longitude) &&
    f.longitude >= -180 &&
    f.longitude <= 180 &&
    typeof f.radiusM === "number" &&
    Number.isFinite(f.radiusM) &&
    f.radiusM > 0
  );
}

/**
 * The cached fences for `userId`, or null when there is nothing usable: no
 * entry, a different owner, malformed JSON, or any fence that fails the shape
 * check (all or nothing, so a half-corrupt entry never warns against the wrong
 * set of sites). Pure, so it can be checked without AsyncStorage.
 */
export function parseFenceCache(
  raw: string | null,
  userId: string,
): Fence[] | null {
  if (!raw) return null;
  try {
    const v = JSON.parse(raw) as unknown;
    if (!v || typeof v !== "object") return null;
    const s = v as Partial<Stored>;
    if (typeof s.userId !== "string" || s.userId !== userId) return null;
    if (!Array.isArray(s.fences) || !s.fences.every(isFence)) return null;
    return s.fences.map((f) => ({
      latitude: f.latitude,
      longitude: f.longitude,
      radiusM: f.radiusM,
    }));
  } catch {
    return null;
  }
}

/** The user id a stored entry belongs to, or null when there is none. */
export function fenceCacheOwner(raw: string | null): string | null {
  if (!raw) return null;
  try {
    const v = JSON.parse(raw) as unknown;
    return v && typeof v === "object" && typeof (v as Stored).userId === "string"
      ? (v as Stored).userId
      : null;
  } catch {
    return null;
  }
}

export async function readFenceCache(userId: string): Promise<Fence[] | null> {
  try {
    return parseFenceCache(await AsyncStorage.getItem(KEY), userId);
  } catch {
    return null;
  }
}

/** Saves the fences for `userId`. An empty list is saved too: it means this
 *  worker has no fence to warn about, which must replace an older non-empty
 *  set. Only the three fields the check reads are kept. */
export async function writeFenceCache(
  userId: string,
  fences: Fence[],
): Promise<void> {
  try {
    const stored: Stored = {
      userId,
      fences: fences.filter(isFence).map((f) => ({
        latitude: f.latitude,
        longitude: f.longitude,
        radiusM: f.radiusM,
      })),
    };
    await AsyncStorage.setItem(KEY, JSON.stringify(stored));
  } catch {
    // A failed write only costs the next cold start its offline warning.
  }
}

export async function clearFenceCache(): Promise<void> {
  try {
    await AsyncStorage.removeItem(KEY);
  } catch {
    // ignore
  }
}

/** Account switch: drop another user's fences as soon as someone else signs
 *  in. Reads already refuse a different owner; this also removes them. */
export async function clearFenceCacheUnlessOwner(userId: string): Promise<void> {
  try {
    const owner = fenceCacheOwner(await AsyncStorage.getItem(KEY));
    if (owner !== null && owner !== userId) await AsyncStorage.removeItem(KEY);
  } catch {
    // ignore
  }
}
