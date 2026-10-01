import type { StoragePort } from '@/core/secure-storage';
// Web preview has no Keychain/Keystore. Deliberately memory-only, never localStorage.
const values = new Map<string, string>();
export const authStorage: StoragePort = {
  getItem: async (key) => values.get(key) ?? null,
  setItem: async (key, value) => {
    values.set(key, value);
  },
  removeItem: async (key) => {
    values.delete(key);
  },
};
