import "server-only";
import { after } from "next/server";

/**
 * Public catalog cache (never for carts, quotes or orders). Price/stock-bearing entries set
 * freshMs = staleMs = keepMs, so they never render after the fresh window or on owner failure.
 * The cache is the isolate's bounded map only: each Next.js server process keeps its own copies.
 * - younger than `freshMs`: served as is;
 * - younger than `staleMs`: served at once while the background reads the owner and refreshes the entry
 *   (the admin edit shows on the next view after that);
 * - older or missing: the page waits for the owner read; if that fails, a value younger than `keepMs`
 *   still renders, so only a key that was never cached shows the catalog error.
 */
interface Entry<T> {
  readonly at: number;
  readonly value: T;
}
export interface CatalogCacheOptions {
  readonly freshMs: number;
  readonly staleMs: number;
  readonly keepMs: number;
  readonly limit: number;
}
/** A background refresh of a key is not started again in this isolate within this window. */
const REFRESH_GUARD_MS = 30_000;

export const catalogCache = <T>(options: CatalogCacheOptions) => {
  const local = new Map<string, Entry<T>>();
  const refreshing = new Map<string, number>();
  const remember = (key: string, entry: Entry<T>) => {
    const own = local.get(key);
    if (own !== undefined && own.at >= entry.at) return;
    local.delete(key);
    if (local.size >= options.limit) {
      const oldest = local.keys().next().value;
      if (oldest !== undefined) local.delete(oldest);
    }
    local.set(key, entry);
  };
  const age = (entry: Entry<T>) => Date.now() - entry.at;

  const read = async (key: string, load: () => Promise<T>) => {
    const value = await load();
    remember(key, { at: Date.now(), value });
    return value;
  };

  /** Start only after the response: owner reads cannot contend with the render. */
  const refreshInBackground = (key: string, load: () => Promise<T>) => {
    const started = refreshing.get(key);
    if (started !== undefined && Date.now() - started < REFRESH_GUARD_MS) return;
    refreshing.set(key, Date.now());
    after(() =>
      read(key, load)
        .catch(() => undefined)
        .finally(() => refreshing.delete(key)),
    );
  };

  return {
    /** The cached value of `key`, refreshed through `load` as described above. */
    get: async (key: string, load: () => Promise<T>): Promise<T> => {
      const entry = local.get(key);
      if (entry !== undefined && age(entry) < options.freshMs) return entry.value;
      if (entry !== undefined && age(entry) < options.staleMs) {
        refreshInBackground(key, load);
        return entry.value;
      }
      try {
        return await read(key, load);
      } catch (error) {
        if (entry !== undefined && age(entry) < options.keepMs) return entry.value;
        throw error;
      }
    },
  };
};
