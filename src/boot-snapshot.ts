import AsyncStorage from "@react-native-async-storage/async-storage";

/**
 * A tiny snapshot of the last successful getStatus, persisted so a cold start
 * can render the correct shell (ClockScreen vs ManagerTabs) immediately from
 * local disk instead of blocking on the network role fetch. The live getStatus
 * still runs and reconciles; the snapshot only removes the first-paint wait.
 *
 * `userId` is stored so the snapshot is only ever trusted for the SAME signed-
 * in user — a different user's cold start falls back to the spinner until their
 * own getStatus answers, never flashing the previous user's shell. Auth itself
 * still gates upstream: a signed-out launch renders Login regardless of any
 * snapshot.
 */
const KEY = "clox.boot.snapshot.v1";

export type BootSnapshot = { userId: string; role: string };

export async function readBootSnapshot(): Promise<BootSnapshot | null> {
  try {
    const raw = await AsyncStorage.getItem(KEY);
    if (!raw) return null;
    const v = JSON.parse(raw) as unknown;
    if (
      v &&
      typeof v === "object" &&
      typeof (v as BootSnapshot).userId === "string" &&
      typeof (v as BootSnapshot).role === "string"
    ) {
      return v as BootSnapshot;
    }
    return null;
  } catch {
    return null;
  }
}

export async function writeBootSnapshot(snap: BootSnapshot): Promise<void> {
  try {
    await AsyncStorage.setItem(KEY, JSON.stringify(snap));
  } catch {
    // A failed snapshot write only costs the next cold start its fast path.
  }
}

export async function clearBootSnapshot(): Promise<void> {
  try {
    await AsyncStorage.removeItem(KEY);
  } catch {
    // ignore
  }
}
