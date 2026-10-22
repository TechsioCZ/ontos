import "server-only";
import { createHash } from "node:crypto";
import { getCloudflareContext } from "@opennextjs/cloudflare";

/**
 * Stale-while-revalidate cache for public catalog reads (never for carts, quotes or orders).
 *
 * Level 1 is the isolate's bounded map. On Workers, level 2 is the colo's Cache API (every isolate of the
 * storefront in that data center) and level 3 the storefront's catalog KV namespace (every data center, so
 * the scheduled warm-up and a deploy's warm-up reach the colo a shopper lands on). A lookup takes the newest.
 * - younger than `freshMs`: served as is;
 * - younger than `staleMs`: served at once while one owner read refreshes every level in the background
 *   (admin edits show on the next view after that read);
 * - older or missing: the page waits for the owner read; if that fails, a value younger than `keepMs`
 *   still renders, so only a key that was never cached shows the catalog error.
 */
interface Entry<T> {
  readonly at: number;
  readonly value: T;
}
interface EdgeCache {
  match(request: Request): Promise<Response | undefined>;
  put(request: Request, response: Response): Promise<void>;
}
interface CatalogStore {
  get(key: string, options: { type: "json"; cacheTtl?: number }): Promise<unknown>;
  put(key: string, value: string, options?: { expirationTtl?: number }): Promise<void>;
}
declare global {
  interface CloudflareEnv {
    STOREFRONT_CATALOG_CACHE?: CatalogStore;
  }
}
export interface CatalogCacheOptions {
  readonly freshMs: number;
  readonly staleMs: number;
  readonly keepMs: number;
  readonly limit: number;
}
export type WarmResult = "fresh" | "refreshed" | "failed";

const EDGE_ORIGIN = "https://akros-catalog.cache.internal";
/** A background refresh of a key is not started again in this isolate within this window. */
const REFRESH_GUARD_MS = 30_000;
/** How long a colo keeps a KV value before reading it again (the KV minimum is 30 s). */
const STORE_READ_TTL_S = 30;

interface Runtime {
  readonly edge: EdgeCache | undefined;
  readonly store: CatalogStore | undefined;
  readonly waitUntil: (promise: Promise<unknown>) => void;
}

const runtime = (): Runtime => {
  try {
    const { ctx, env } = getCloudflareContext();
    const edge = (globalThis as { caches?: { default?: EdgeCache } }).caches?.default;
    return {
      edge,
      store: env.STOREFRONT_CATALOG_CACHE,
      waitUntil: (promise) => ctx.waitUntil(promise),
    };
  } catch {
    // A plain Next.js server (local demo) has no Cloudflare request context: the isolate map only.
    return { edge: undefined, store: undefined, waitUntil: () => undefined };
  }
};

const isEntry = <T>(value: unknown): value is Entry<T> =>
  typeof value === "object" &&
  value !== null &&
  typeof (value as Entry<T>).at === "number" &&
  "value" in value;

export const catalogCache = <T>(name: string, options: CatalogCacheOptions) => {
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
  const hashed = (key: string) => `${name}/${createHash("sha256").update(key).digest("hex")}`;
  const age = (entry: Entry<T>) => Date.now() - entry.at;
  const newest = (...entries: (Entry<T> | undefined)[]) =>
    entries.reduce<Entry<T> | undefined>(
      (best, entry) =>
        entry !== undefined && (best === undefined || entry.at > best.at) ? entry : best,
      undefined,
    );

  const recall = async (key: string, { edge, store }: Runtime) => {
    const own = local.get(key);
    if (own !== undefined && age(own) < options.freshMs) return own;
    const id = hashed(key);
    const [colo, global] = await Promise.all([
      edge
        ?.match(new Request(`${EDGE_ORIGIN}/${id}`))
        .then((response) => (response ? response.json() : undefined))
        .catch(() => undefined),
      store?.get(id, { type: "json", cacheTtl: STORE_READ_TTL_S }).catch(() => undefined),
    ]);
    const found = newest(
      own,
      isEntry<T>(colo) ? colo : undefined,
      isEntry<T>(global) ? global : undefined,
    );
    if (found === undefined || age(found) >= options.keepMs) return undefined;
    remember(key, found);
    return found;
  };

  const save = (key: string, entry: Entry<T>, { edge, store, waitUntil }: Runtime) => {
    remember(key, entry);
    const id = hashed(key);
    const body = JSON.stringify(entry);
    const keepS = Math.ceil(options.keepMs / 1000);
    if (edge !== undefined) {
      const response = new Response(body, {
        headers: {
          "cache-control": `public, max-age=${keepS}`,
          "content-type": "application/json",
        },
      });
      waitUntil(edge.put(new Request(`${EDGE_ORIGIN}/${id}`), response).catch(() => undefined));
    }
    if (store !== undefined)
      waitUntil(store.put(id, body, { expirationTtl: keepS }).catch(() => undefined));
  };

  const read = async (key: string, load: () => Promise<T>, context: Runtime) => {
    const value = await load();
    save(key, { at: Date.now(), value }, context);
    return value;
  };

  /** One background refresh per key and isolate at a time; the read outlives the page that started it. */
  const refreshInBackground = (key: string, load: () => Promise<T>, context: Runtime) => {
    const started = refreshing.get(key);
    if (started !== undefined && Date.now() - started < REFRESH_GUARD_MS) return;
    refreshing.set(key, Date.now());
    context.waitUntil(
      read(key, load, context)
        .catch(() => undefined)
        .finally(() => refreshing.delete(key)),
    );
  };

  return {
    /** The cached value of `key`, refreshed through `load` as described above. */
    get: async (key: string, load: () => Promise<T>): Promise<T> => {
      const context = runtime();
      const entry = await recall(key, context);
      if (entry !== undefined && age(entry) < options.freshMs) return entry.value;
      if (entry !== undefined && age(entry) < options.staleMs) {
        refreshInBackground(key, load, context);
        return entry.value;
      }
      try {
        return await read(key, load, context);
      } catch (error) {
        if (entry !== undefined) return entry.value;
        throw error;
      }
    },
    /** Reads `key` from the owner unless a cached value is younger than `minAgeMs` (scheduled warm-up). */
    warm: async (key: string, load: () => Promise<T>, minAgeMs: number): Promise<WarmResult> => {
      const context = runtime();
      const entry = await recall(key, context);
      if (entry !== undefined && age(entry) < minAgeMs) return "fresh";
      return await read(key, load, context).then(
        () => "refreshed" as const,
        () => "failed" as const,
      );
    },
  };
};
