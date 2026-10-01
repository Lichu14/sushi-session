export interface StoragePort {
  getItem(key: string): Promise<string | null>;
  setItem(key: string, value: string): Promise<void>;
  removeItem(key: string): Promise<void>;
}
// Small encrypted chunks avoid platform limits on large Supabase session payloads.
// Publish the manifest only after every chunk is durable; a failed write keeps the old session.
export function createChunkedStorage(
  store: StoragePort,
  generation: () => string,
): StoragePort {
  type Manifest = { generation: string; count: number };
  async function manifest(key: string): Promise<Manifest | null> {
    const raw = await store.getItem(key);
    if (!raw) return null;
    const value = JSON.parse(raw) as Manifest;
    if (
      !/^[a-zA-Z0-9-]+$/.test(value.generation) ||
      !Number.isInteger(value.count) ||
      value.count < 1 ||
      value.count > 256
    )
      throw new Error('Invalid secure storage manifest');
    return value;
  }
  const part = (key: string, value: Manifest, i: number) =>
    `${key}.${value.generation}.${i}`;
  async function clean(key: string, value: Manifest | null) {
    if (value)
      await Promise.all(
        Array.from({ length: value.count }, (_, i) =>
          store.removeItem(part(key, value, i)),
        ),
      );
  }
  return {
    async getItem(key) {
      const value = await manifest(key);
      if (!value) return null;
      const chunks = await Promise.all(
        Array.from({ length: value.count }, (_, i) =>
          store.getItem(part(key, value, i)),
        ),
      );
      if (chunks.some((chunk) => chunk === null))
        throw new Error('Incomplete secure session');
      return chunks.join('');
    },
    async setItem(key, text) {
      const old = await manifest(key),
        chars = Array.from(text);
      const chunks: string[] = [];
      for (let i = 0; i < chars.length; i += 400)
        chunks.push(chars.slice(i, i + 400).join(''));
      if (!chunks.length) chunks.push('');
      if (chunks.length > 256)
        throw new Error('Session exceeds secure storage limit');
      const value = { generation: generation(), count: chunks.length };
      try {
        for (let i = 0; i < chunks.length; i++)
          await store.setItem(part(key, value, i), chunks[i]);
        await store.setItem(key, JSON.stringify(value));
      } catch (error) {
        await clean(key, value).catch(() => {});
        throw error;
      }
      await clean(key, old);
    },
    async removeItem(key) {
      const old = await manifest(key);
      await store.removeItem(key);
      await clean(key, old);
    },
  };
}
