import "server-only";
import { Effect } from "effect";
import { createOperation } from "@ontos/storefront-runtime";
import type { Operation } from "@ontos/storefront-runtime";

// Process-wide owner reads shared across requests for a short time. Each load runs under its own operation, so one
// shopper's aborted request (header search aborts on every keystroke) never rejects the read for other waiters.
// A rejected read is evicted at once; it is never served.
interface Entry {
  at: number;
  generation: number | undefined;
  value: Promise<unknown>;
  done: boolean;
  refreshing: boolean;
  /** The settled answer of the generation this entry's first read replaces, for readers with `waitMs`. */
  replaced: { at: number; value: Promise<unknown> } | undefined;
  /** When a visitor last read this key (a renewal is none). */
  hitAt: number;
  /** Reads this key again for a newer generation (`renewSharedReads`). */
  renew: (generation: number) => Promise<void>;
}
const entries = new Map<string, Entry>();
// Full product records are large and the heap is about 281 MB: keep the newest entries only.
const MAX_ENTRIES = 200;
// Older stale values are not served; they reload with a blocking read.
export const MAX_STALE_MS = 10 * 60_000;
// Least recently used goes first: every hit and write moves its key to the end, so the market directory and the
// tree, hit on every request, are never evicted by a burst of distinct search terms.
const put = (key: string, entry: Entry) => {
  entries.delete(key);
  entries.set(key, entry);
  if (entries.size > MAX_ENTRIES) entries.delete(entries.keys().next().value!);
};

/** Tests: forget every shared read. */
export const clearSharedReads = () => entries.clear();

const detached = <A>(load: (operation: Operation) => Promise<A>): Promise<A> => {
  const operation = Effect.runSync(createOperation());
  return load(operation).finally(() => operation.dispose());
};

/** The caller stops waiting when its own operation ends; the shared read itself goes on for other waiters. */
export const joined = <A>(value: Promise<A>, caller: Operation | undefined): Promise<A> =>
  caller === undefined
    ? value
    : new Promise<A>((resolve, reject) => {
        const stop = () => {
          try {
            caller.check();
          } catch (error) {
            reject(error);
          }
        };
        if (caller.signal.aborted) return stop();
        caller.signal.addEventListener("abort", stop, { once: true });
        value.then(
          (result) => {
            caller.signal.removeEventListener("abort", stop);
            resolve(result);
          },
          (error: unknown) => {
            caller.signal.removeEventListener("abort", stop);
            reject(error);
          },
        );
      });

/** Entries a visitor read within this long are read again at once for a new generation. */
const RENEW_WITHIN_MS = 5 * 60_000;
const RENEW_LIMIT = 24;
const RENEW_CONCURRENCY = 4;

/**
 * Reads the entries visitors used lately again for `generation` (the owner's newer revision), newest visit first and
 * four at a time, so the first visit after an admin save finds its answer read instead of waiting for it or, with
 * `waitMs`, getting the replaced generation's answer.
 */
export const renewSharedReads = (generation: number) => {
  const now = Date.now();
  const due = [...entries.values()]
    .filter(
      (entry) =>
        entry.generation !== undefined &&
        entry.generation < generation &&
        now - entry.hitAt < RENEW_WITHIN_MS,
    )
    .sort((left, right) => right.hitAt - left.hitAt)
    .slice(0, RENEW_LIMIT);
  const work = async () => {
    for (let entry = due.shift(); entry !== undefined; entry = due.shift())
      await entry.renew(generation);
  };
  for (let worker = 0; worker < RENEW_CONCURRENCY; worker += 1) void work();
};

/**
 * `ttlMs` fresh; with `stale`, an older settled value keeps being served while one background refresh replaces it.
 * A value read at another `generation` (the owner's revision) is served only to a reader with `waitMs` whose new
 * generation's read has not answered within `waitMs` (while an owner outage would still serve it); otherwise the
 * read waits for its own load.
 */
export function sharedRead<A>(
  key: string,
  ttlMs: number,
  load: (operation: Operation) => Promise<A>,
  {
    stale = false,
    caller,
    generation,
    waitMs,
  }: { stale?: boolean; caller?: Operation; generation?: number; waitMs?: number } = {},
): Promise<A> {
  return joined(read(key, ttlMs, load, stale, generation, waitMs), caller);
}

/** The entry's read, or after `waitMs` (or when it fails) the answer of the generation it replaces. */
const within = <A>(entry: Entry, waitMs: number | undefined): Promise<A> => {
  const { replaced } = entry;
  if (
    entry.done ||
    waitMs === undefined ||
    replaced === undefined ||
    Date.now() - replaced.at >= MAX_STALE_MS
  )
    return entry.value as Promise<A>;
  let timer: ReturnType<typeof setTimeout> | undefined;
  return Promise.race([
    entry.value.catch(() => replaced.value),
    new Promise<void>((resolve) => {
      timer = setTimeout(resolve, waitMs);
    }).then(() => replaced.value),
  ]).finally(() => clearTimeout(timer)) as Promise<A>;
};

function read<A>(
  key: string,
  ttlMs: number,
  load: (operation: Operation) => Promise<A>,
  stale: boolean,
  generation: number | undefined,
  waitMs: number | undefined,
  renewal = false,
): Promise<A> {
  const found = entries.get(key);
  const held = found?.generation === generation ? found : undefined;
  if (held !== undefined && !renewal) held.hitAt = Date.now();
  if (held !== undefined) {
    entries.delete(key);
    entries.set(key, held);
  }
  if (held !== undefined && (Date.now() - held.at < ttlMs || !held.done))
    return within(held, waitMs);
  if (held !== undefined && stale && Date.now() - held.at < MAX_STALE_MS) {
    if (!held.refreshing) {
      held.refreshing = true;
      detached(load).then(
        (value) => {
          // Replaced by another generation's read (or evicted) meanwhile: this refresh no longer belongs here.
          if (entries.get(key) !== held) return;
          put(key, {
            at: Date.now(),
            generation,
            value: Promise.resolve(value),
            done: true,
            refreshing: false,
            replaced: undefined,
            hitAt: held.hitAt,
            renew: held.renew,
          });
        },
        () => {
          held.refreshing = false;
        },
      );
    }
    return held.value as Promise<A>;
  }
  const value = detached(load);
  // A new generation's first read keeps the settled answer it replaces for readers that cannot wait.
  const replaced =
    found === undefined || found === held
      ? undefined
      : found.done
        ? { at: found.at, value: found.value }
        : found.replaced;
  const entry: Entry = {
    at: Date.now(),
    generation,
    value,
    done: false,
    refreshing: false,
    replaced,
    hitAt: renewal && found !== undefined ? found.hitAt : Date.now(),
    renew: async (next) => {
      const current = entries.get(key)?.generation;
      // A visitor or an earlier renewal already reads this key at that generation or a newer one.
      if (current !== undefined && current >= next) return;
      await read(key, ttlMs, load, stale, next, undefined, true).then(
        () => undefined,
        () => undefined,
      );
    },
  };
  put(key, entry);
  value.then(
    () => {
      entry.done = true;
    },
    () => {
      if (entries.get(key) === entry) entries.delete(key);
    },
  );
  return within(entry, waitMs);
}
