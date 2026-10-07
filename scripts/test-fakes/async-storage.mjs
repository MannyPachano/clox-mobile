// In-memory AsyncStorage for the node checks.
const store = new Map();
const AsyncStorage = {
  async getItem(key) {
    return store.has(key) ? store.get(key) : null;
  },
  async setItem(key, value) {
    store.set(key, String(value));
  },
  async removeItem(key) {
    store.delete(key);
  },
  /** Test helper: forget everything. */
  _reset() {
    store.clear();
  },
};
export default AsyncStorage;
