/** Plain in-memory cache, no TTL. `drop(prefix)` clears keys after branch/commit ops. */
export function createCache<T>() {
  const map = new Map<string, T>();
  return {
    get: (key: string): T | undefined => map.get(key),
    set: (key: string, value: T): void => void map.set(key, value),
    drop(prefix: string): void {
      for (const key of [...map.keys()]) if (key.startsWith(prefix)) map.delete(key);
    },
  };
}
