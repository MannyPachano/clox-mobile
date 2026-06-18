import * as SecureStore from "expo-secure-store";

/**
 * Supabase auth-storage adapter backed by the device keychain/keystore
 * (expo-secure-store), so the session is encrypted at rest.
 *
 * SecureStore values can be unreliable above ~2KB on Android, and a Supabase
 * session (access + refresh tokens + user) can exceed that — so we transparently
 * split large values across numbered chunk keys and reassemble on read.
 */
const CHUNK_SIZE = 1800;

const chunkKey = (key: string, i: number): string => `${key}__c${i}`;
const countKey = (key: string): string => `${key}__count`;

export const SecureStoreAdapter = {
  getItem: async (key: string): Promise<string | null> => {
    const countRaw = await SecureStore.getItemAsync(countKey(key));
    if (countRaw == null) {
      // Small value stored directly under `key` — or nothing stored at all.
      return SecureStore.getItemAsync(key);
    }
    const count = parseInt(countRaw, 10);
    if (!Number.isFinite(count) || count <= 0) return null;
    let out = "";
    for (let i = 0; i < count; i++) {
      const part = await SecureStore.getItemAsync(chunkKey(key, i));
      if (part == null) return null; // partial/corrupt → treat as no session
      out += part;
    }
    return out;
  },

  setItem: async (key: string, value: string): Promise<void> => {
    // Clear any prior representation first so single<->chunked transitions
    // never leave stale data behind.
    await SecureStoreAdapter.removeItem(key);

    if (value.length <= CHUNK_SIZE) {
      await SecureStore.setItemAsync(key, value);
      return;
    }
    const count = Math.ceil(value.length / CHUNK_SIZE);
    await SecureStore.setItemAsync(countKey(key), String(count));
    for (let i = 0; i < count; i++) {
      await SecureStore.setItemAsync(
        chunkKey(key, i),
        value.slice(i * CHUNK_SIZE, (i + 1) * CHUNK_SIZE),
      );
    }
  },

  removeItem: async (key: string): Promise<void> => {
    const countRaw = await SecureStore.getItemAsync(countKey(key));
    if (countRaw != null) {
      const count = parseInt(countRaw, 10);
      if (Number.isFinite(count)) {
        for (let i = 0; i < count; i++) {
          await SecureStore.deleteItemAsync(chunkKey(key, i));
        }
      }
      await SecureStore.deleteItemAsync(countKey(key));
    }
    await SecureStore.deleteItemAsync(key);
  },
};
