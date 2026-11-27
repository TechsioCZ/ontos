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
  /** With `waitMs`, while this entry's load is pending: the settled answer of the same generation it replaces. */
  previous?: Entry;
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
const joined = <A>(value: Promise<A>, caller: Operation | undefined): Promise<A> =>
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

/** The load's answer when it settles within `ms`; otherwise, or when it fails, the answer it replaces. */
const within = <A>(value: Promise<A>, previous: Promise<A>, ms: number): Promise<A> =>
  new Promise<A>((resolve) => {
    const timer = setTimeout(() => resolve(previous), ms);
    value.then(
      (result) => {
        clearTimeout(timer);
        resolve(result);
      },
      () => {
        clearTimeout(timer);
        resolve(previous);
      },
    );
  });

/**
 * `ttlMs` fresh; with `stale`, an older settled value keeps being served while one background refresh replaces it.
 * With `waitMs`, a reader waits at most that long for a newer read: then it gets the answer that read replaces (at most
 * 10 minutes old), and the newer read, which goes on, answers the readers after it.
 * A value read at another `generation` (the owner's revision) is never served: the read waits for its own load.
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

function read<A>(
  key: string,
  ttlMs: number,
  load: (operation: Operation) => Promise<A>,
  stale: boolean,
  generation: number | undefined,
  waitMs: number | undefined,
): Promise<A> {
  const found = entries.get(key);
  const held = found?.generation === generation ? found : undefined;
  if (held !== undefined) {
    entries.delete(key);
    entries.set(key, held);
  }
  if (held !== undefined && (Date.now() - held.at < ttlMs || !held.done))
    return held.previous === undefined || waitMs === undefined
      ? (held.value as Promise<A>)
      : within(held.value as Promise<A>, held.previous.value as Promise<A>, waitMs);
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
  const previous =
    waitMs !== undefined && held?.done === true && Date.now() - held.at < MAX_STALE_MS
      ? held
      : undefined;
  const entry: Entry = {
    at: Date.now(),
    generation,
    value,
    done: false,
    refreshing: false,
    previous,
  };
  put(key, entry);
  value.then(
    () => {
      entry.done = true;
      entry.previous = undefined;
    },
    () => {
      if (entries.get(key) !== entry) return;
      // The replaced answer stays for waiting readers; the next read after it tries a new load.
      if (previous === undefined) entries.delete(key);
      else put(key, previous);
    },
  );
  return previous === undefined || waitMs === undefined
    ? value
    : within(value, previous.value as Promise<A>, waitMs);
}
