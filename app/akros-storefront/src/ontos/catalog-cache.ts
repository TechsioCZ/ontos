import "server-only";
import { createHash } from "node:crypto";
import { getCloudflareContext } from "@opennextjs/cloudflare";
import { after } from "next/server";

/**
 * Public catalog cache (never for carts, quotes or orders). Price/stock-bearing entries set
 * freshMs = staleMs = keepMs, so they never render after the fresh window or on owner failure.
 * Prices use only the isolate's bounded map: a shared lookup can outlast their ten-second lifetime,
 * and KV's minimum lookup TTL is thirty seconds. Missing/expired prices read the owner immediately.
 * Only price-free category/navigation entries use shared storage, stale refresh and failure retention.
 *
 * Level 1 is the isolate's bounded map. On Workers, level 2 is the colo's Cache API (every isolate of the
 * storefront in that data center) and level 3 the storefront's catalog KV namespace (every data center).
 * Shopper requests populate these levels. The isolate's own value
 * renders without any lookup while it is younger than `staleMs`; otherwise a valid fresh colo copy is
 * taken without waiting for the concurrent KV lookup. If the colo copy is not fresh or cannot be decoded,
 * the newest remaining shared copy is taken. Shared copies carry their timestamp outside the body
 * (colo header, KV metadata), so only the selected copy is parsed unless its body is unreadable.
 * - younger than `freshMs`: served as is;
 * - younger than `staleMs`: served at once while the background takes a shared copy younger than `freshMs`
 *   or reads the owner and refreshes every level (admin edits show on the next view after that);
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
  getWithMetadata(
    key: string,
    options: { type: "text"; cacheTtl?: number },
  ): Promise<{ value: string | null; metadata: unknown }>;
  put(
    key: string,
    value: string,
    options?: { expirationTtl?: number; metadata?: { at: number } },
  ): Promise<void>;
}
declare global {
  interface CloudflareEnv {
    STOREFRONT_CATALOG_CACHE?: CatalogStore;
  }
}
export interface CatalogCacheOptions {
  /** Short-lived prices stay local; only price-free navigation uses Cache API and KV. */
  readonly storage: "isolate" | "shared";
  readonly freshMs: number;
  readonly staleMs: number;
  readonly keepMs: number;
  readonly limit: number;
}
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

/** A shared copy whose age is known without parsing it (colo header or KV metadata). */
interface SharedCopy {
  readonly at: number;
  readonly text: () => Promise<string>;
}
const AT_HEADER = "x-catalog-at";
const atOf = (value: unknown) =>
  typeof value === "number" && Number.isFinite(value) ? value : undefined;

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
  const keyOf = (id: string) => new Request(`${EDGE_ORIGIN}/${id}`);

  /** Adopts a shared copy newer than the isolate's own (parsing only that one copy). */
  const adopt = async (key: string, copy: SharedCopy): Promise<Entry<T> | undefined> => {
    const own = local.get(key);
    if (own !== undefined && own.at >= copy.at) return own;
    try {
      const entry = { at: copy.at, value: (JSON.parse(await copy.text()) as Entry<T>).value };
      remember(key, entry);
      return entry;
    } catch {
      return own;
    }
  };

  /** Adopts a valid fresh colo copy of `key`, otherwise the newest shared copy. */
  const shared = async (
    key: string,
    context: Runtime | undefined,
  ): Promise<Entry<T> | undefined> => {
    if (context === undefined) return undefined;
    const { edge, store } = context;
    const id = hashed(key);
    // Start both reads before awaiting either, so colo misses do not serialize Cache API and KV I/O.
    const globalRead = store
      ?.getWithMetadata(id, { type: "text", cacheTtl: STORE_READ_TTL_S })
      .then(({ value, metadata }): SharedCopy | undefined => {
        const at = atOf((metadata as { at?: unknown } | null)?.at);
        return value !== null && at !== undefined ? { at, text: async () => value } : undefined;
      })
      .catch(() => undefined);
    let colo = await edge
      ?.match(keyOf(id))
      .then((response): SharedCopy | undefined => {
        const at = atOf(Number(response?.headers.get(AT_HEADER)));
        return response && at !== undefined ? { at, text: () => response.text() } : undefined;
      })
      .catch(() => undefined);
    // A valid fresh colo copy can render without waiting for KV, even if KV holds a newer copy.
    // Decode before returning: an unreadable colo body must not hide usable KV navigation.
    if (colo !== undefined && Date.now() - colo.at < options.freshMs) {
      const entry = await adopt(key, colo);
      if (entry !== undefined && entry.at >= colo.at) return entry;
      colo = undefined;
    }
    const global = await globalRead;
    const copy =
      colo !== undefined && (global === undefined || colo.at >= global.at) ? colo : global;
    return copy === undefined ? undefined : adopt(key, copy);
  };

  /**
   * The isolate's own value while it may still render (younger than `staleMs`); otherwise a fresh colo
   * copy or the newest of the isolate's and shared copies.
   */
  const recall = async (key: string, context: Runtime | undefined) => {
    const own = local.get(key);
    if (own !== undefined && age(own) < options.staleMs) return own;
    const found = (await shared(key, context)) ?? own;
    return found === undefined || age(found) >= options.keepMs ? undefined : found;
  };

  const save = (key: string, entry: Entry<T>, context: Runtime | undefined) => {
    remember(key, entry);
    if (context === undefined) return;
    const { edge, store, waitUntil } = context;
    const id = hashed(key);
    const body = JSON.stringify(entry);
    const keepS = Math.ceil(options.keepMs / 1000);
    if (edge !== undefined) {
      const response = new Response(body, {
        headers: {
          "cache-control": `public, max-age=${keepS}`,
          "content-type": "application/json",
          [AT_HEADER]: String(entry.at),
        },
      });
      waitUntil(edge.put(keyOf(id), response).catch(() => undefined));
    }
    if (store !== undefined)
      waitUntil(
        store
          // KV requires at least 60 seconds of storage. The entry timestamp, not its storage TTL,
          // governs whether a price may render; a retained copy past freshMs is never served.
          .put(id, body, { expirationTtl: Math.max(60, keepS), metadata: { at: entry.at } })
          .catch(() => undefined),
      );
  };

  const read = async (key: string, load: () => Promise<T>, context: Runtime | undefined) => {
    const value = await load();
    save(key, { at: Date.now(), value }, context);
    return value;
  };

  /** A shared copy another isolate refreshed recently enough, else an owner read. */
  const refresh = async (key: string, load: () => Promise<T>, context: Runtime | undefined) => {
    const entry = await shared(key, context);
    if (entry !== undefined && age(entry) < options.freshMs) return;
    await read(key, load, context);
  };

  /** Start only after the response: owner reads and gateway mints cannot contend with the render.
   * Next's after() keeps the callback alive via the Worker's waitUntil; shared-cache writes use ctx too. */
  const refreshInBackground = (
    key: string,
    load: () => Promise<T>,
    context: Runtime | undefined,
  ) => {
    const started = refreshing.get(key);
    if (started !== undefined && Date.now() - started < REFRESH_GUARD_MS) return;
    refreshing.set(key, Date.now());
    after(() =>
      refresh(key, load, context)
        .catch(() => undefined)
        .finally(() => refreshing.delete(key)),
    );
  };

  return {
    /** The cached value of `key`, refreshed through `load` as described above. */
    get: async (key: string, load: () => Promise<T>): Promise<T> => {
      const context = options.storage === "shared" ? runtime() : undefined;
      const entry = await recall(key, context);
      if (entry !== undefined && age(entry) < options.freshMs) return entry.value;
      if (entry !== undefined && age(entry) < options.staleMs) {
        refreshInBackground(key, load, context);
        return entry.value;
      }
      try {
        return await read(key, load, context);
      } catch (error) {
        if (entry !== undefined && age(entry) < options.keepMs) return entry.value;
        throw error;
      }
    },
  };
};
