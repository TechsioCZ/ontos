import "server-only";
import { createHash } from "node:crypto";
import { getCloudflareContext } from "@opennextjs/cloudflare";

/**
 * Stale-while-revalidate cache for public catalog reads (never for carts, quotes or orders).
 *
 * Level 1 is the isolate's bounded map; on Workers, level 2 is the colo's Cache API, shared by every isolate
 * of the storefront (a fresh isolate otherwise pays a full OntOS round trip per page).
 * - younger than `freshMs`: served as is;
 * - older (up to `keepMs`): one owner read starts; the page waits for it at most `refreshWaitMs` and otherwise
 *   renders the previous value while the read finishes in the background and refreshes both levels;
 * - an owner failure while a previous value exists renders that value; with no value the caller waits.
 */
interface Entry<T> {
  readonly at: number;
  readonly value: T;
}
interface EdgeCache {
  match(request: Request): Promise<Response | undefined>;
  put(request: Request, response: Response): Promise<void>;
}
export interface CatalogCacheOptions {
  readonly freshMs: number;
  readonly keepMs: number;
  readonly refreshWaitMs: number;
  readonly limit: number;
}

const EDGE_ORIGIN = "https://akros-catalog.cache.internal";

const runtime = (): {
  edge: EdgeCache | undefined;
  waitUntil: (promise: Promise<unknown>) => void;
} => {
  try {
    const { ctx } = getCloudflareContext();
    const edge = (globalThis as { caches?: { default?: EdgeCache } }).caches?.default;
    return { edge, waitUntil: (promise) => ctx.waitUntil(promise) };
  } catch {
    // A plain Next.js server (local demo) has no Cloudflare request context: the isolate map only.
    return { edge: undefined, waitUntil: () => undefined };
  }
};

const sleep = (ms: number) =>
  new Promise<undefined>((resolve) => setTimeout(resolve, ms, undefined));

export const catalogCache = <T>(name: string, options: CatalogCacheOptions) => {
  const local = new Map<string, Entry<T>>();
  const remember = (key: string, entry: Entry<T>) => {
    local.delete(key);
    if (local.size >= options.limit) {
      const oldest = local.keys().next().value;
      if (oldest !== undefined) local.delete(oldest);
    }
    local.set(key, entry);
  };
  const edgeRequest = (key: string) =>
    new Request(`${EDGE_ORIGIN}/${name}/${createHash("sha256").update(key).digest("hex")}`);
  const age = (entry: Entry<T>) => Date.now() - entry.at;

  const recall = async (key: string, edge: EdgeCache | undefined) => {
    const own = local.get(key);
    if (own !== undefined && age(own) < options.freshMs) return own;
    const shared =
      edge === undefined
        ? undefined
        : await edge
            .match(edgeRequest(key))
            .then((response) => (response ? (response.json() as Promise<Entry<T>>) : undefined))
            .catch(() => undefined);
    const newest = shared !== undefined && (own === undefined || shared.at > own.at) ? shared : own;
    if (newest === undefined || age(newest) >= options.keepMs) return undefined;
    if (newest === shared) remember(key, shared);
    return newest;
  };

  const refresh = (key: string, load: () => Promise<T>) => {
    const { edge, waitUntil } = runtime();
    const reading = load().then((value) => {
      const entry = { at: Date.now(), value };
      remember(key, entry);
      if (edge !== undefined) {
        const response = new Response(JSON.stringify(entry), {
          headers: {
            "cache-control": `public, max-age=${Math.ceil(options.keepMs / 1000)}`,
            "content-type": "application/json",
          },
        });
        waitUntil(edge.put(edgeRequest(key), response).catch(() => undefined));
      }
      return value;
    });
    // The read outlives a page that already rendered the previous value.
    waitUntil(reading.catch(() => undefined));
    return reading;
  };

  return {
    /** The cached value of `key`, refreshed through `load` as described above. */
    get: async (key: string, load: () => Promise<T>): Promise<T> => {
      const { edge } = runtime();
      const entry = await recall(key, edge);
      if (entry !== undefined && age(entry) < options.freshMs) return entry.value;
      const reading = refresh(key, load);
      if (entry === undefined) return await reading;
      const settled = await Promise.race([
        reading.then(
          (value) => ({ value }),
          () => ({ value: entry.value }),
        ),
        sleep(options.refreshWaitMs),
      ]);
      return settled === undefined ? entry.value : settled.value;
    },
  };
};
