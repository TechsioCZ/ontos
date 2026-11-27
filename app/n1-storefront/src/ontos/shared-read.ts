import "server-only";
import { Effect } from "effect";
import { createOperation } from "@ontos/storefront-runtime";
import type { Operation, OperationOptions } from "@ontos/storefront-runtime";

// Process-wide public owner reads (the same for every shopper of a market) shared across requests for a short time.
// Each load runs under its own operation, so one shopper's aborted request never rejects the read for other waiters.
// A rejected read, or a settled value `keep` refuses (an unavailable answer), is evicted at once and never served again.
interface Entry {
  at: number;
  generation: number | undefined;
  value: Promise<unknown>;
  done: boolean;
  refreshing: boolean;
}
const entries = new Map<string, Entry>();
// Full product records are large: keep the newest entries only, least recently used first out.
const MAX_ENTRIES = 200;
/** Older stale values are not served; they reload with a blocking read. */
export const MAX_STALE_MS = 10 * 60_000;
const put = (key: string, entry: Entry) => {
  entries.delete(key);
  entries.set(key, entry);
  if (entries.size > MAX_ENTRIES) entries.delete(entries.keys().next().value!);
};

const detached = <A>(load: (operation: Operation) => Promise<A>): Promise<A> => {
  const operation = Effect.runSync(createOperation());
  return load(operation).finally(() => {
    operation.dispose();
  });
};

/** The caller stops waiting when its own request ends; the shared read itself goes on for other waiters. */
export const joined = <A>(
  value: Promise<A>,
  { operation, signal }: OperationOptions,
): Promise<A> => {
  const signals = [...(signal ? [signal] : []), ...(operation ? [operation.signal] : [])];
  if (signals.length === 0) return value;
  const stop = AbortSignal.any(signals);
  return new Promise<A>((resolve, reject) => {
    const abort = () => reject(stop.reason);
    if (stop.aborted) return abort();
    stop.addEventListener("abort", abort, { once: true });
    value.then(
      (result) => {
        stop.removeEventListener("abort", abort);
        resolve(result);
      },
      (error: unknown) => {
        stop.removeEventListener("abort", abort);
        reject(error);
      },
    );
  });
};

/**
 * `ttlMs` fresh; with `stale`, an older kept value keeps being served while one background refresh replaces it.
 * A value read at another `generation` (the owner's catalogue revision) is never served: the read waits for its own load.
 */
export function sharedRead<A>(
  key: string,
  ttlMs: number,
  load: (operation: Operation) => Promise<A>,
  {
    caller = {},
    generation,
    keep = () => true,
    stale = false,
  }: {
    caller?: OperationOptions;
    generation?: number;
    keep?: (value: A) => boolean;
    stale?: boolean;
  } = {},
): Promise<A> {
  const found = entries.get(key);
  const held = found?.generation === generation ? found : undefined;
  if (held !== undefined) put(key, held);
  if (held !== undefined && (Date.now() - held.at < ttlMs || !held.done))
    return joined(held.value as Promise<A>, caller);
  if (held !== undefined && stale && Date.now() - held.at < MAX_STALE_MS) {
    if (!held.refreshing) {
      held.refreshing = true;
      detached(load).then(
        (value) => {
          // Replaced by another generation's read (or evicted) meanwhile: this refresh no longer belongs here.
          if (entries.get(key) !== held) return;
          if (!keep(value)) {
            held.refreshing = false;
            return;
          }
          put(key, {
            at: Date.now(),
            done: true,
            generation,
            refreshing: false,
            value: Promise.resolve(value),
          });
        },
        () => {
          held.refreshing = false;
        },
      );
    }
    return joined(held.value as Promise<A>, caller);
  }
  const value = detached(load);
  const entry: Entry = { at: Date.now(), done: false, generation, refreshing: false, value };
  put(key, entry);
  value.then(
    (result) => {
      if (keep(result)) entry.done = true;
      else if (entries.get(key) === entry) entries.delete(key);
    },
    () => {
      if (entries.get(key) === entry) entries.delete(key);
    },
  );
  return joined(value, caller);
}
