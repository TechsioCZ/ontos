import "server-only";
import { Option, Schema } from "effect";
import { createOperation, OperationError } from "@ontos/storefront-runtime";
import type { Operation, OperationOptions } from "@ontos/storefront-runtime";
import { storefrontRuntime } from "./runtime";

// Process-wide public owner reads (the same for every shopper of a market) shared across requests for a short time.
// Each load runs under its own operation, so one shopper's aborted request never rejects the read for other waiters.
// A rejected read, or a settled value `keep` refuses (an unavailable answer), is evicted at once and never served again.
interface Entry<A> {
  at: number;
  done: boolean;
  generation: number | undefined;
  refreshing: boolean;
  replaced: { at: number; value: Promise<A> } | null;
  value: Promise<A>;
}
// One process-wide LRU budget across typed read families.
const retained = new Map<object, () => void>();
const MAX_ENTRIES = 200;
export const MAX_STALE_MS = 10 * 60_000;

const detached = async <A>(load: (operation: Operation) => Promise<A>): Promise<A> => {
  const operation = storefrontRuntime.runSync(createOperation());
  try {
    return await load(operation);
  } finally {
    operation.dispose();
  }
};

/** Cancel this caller's wait; the owner operation remains alive for other readers. */
export const joined = async <A>(
  value: Promise<A>,
  { operation, signal }: OperationOptions,
): Promise<A> => {
  const signals = [...(signal ? [signal] : []), ...(operation ? [operation.signal] : [])];
  if (signals.length === 0) {
    return await value;
  }
  const stop = AbortSignal.any(signals);
  const cancelled = Promise.withResolvers<never>();
  const abort = () => {
    const reason = Schema.decodeUnknownOption(Schema.instanceOf(Error))(stop.reason).pipe(
      Option.getOrElse(() => new OperationError("cancelled")),
    );
    cancelled.reject(reason);
  };
  stop.addEventListener("abort", abort, { once: true });
  if (stop.aborted) {
    abort();
  }
  try {
    const result = await Promise.race([value, cancelled.promise]);
    // A fulfilled cached value can win race's microtask ordering even when abort already fired.
    if (stop.aborted) {
      return await cancelled.promise;
    }
    return result;
  } finally {
    stop.removeEventListener("abort", abort);
  }
};

const replacedAnswer = <A>(found: Entry<A> | undefined, held: Entry<A> | undefined) => {
  if (found === undefined || found === held) {
    return null;
  }
  return found.done ? { at: found.at, value: found.value } : found.replaced;
};

/** The current answer, or the settled previous generation after the caller's wait budget. */
const within = async <A>(
  entry: Entry<A>,
  waitMs: number | undefined,
  keep: (value: A) => boolean,
): Promise<A> => {
  const { replaced } = entry;
  if (
    entry.done ||
    waitMs === undefined ||
    replaced === null ||
    Date.now() - replaced.at >= MAX_STALE_MS
  ) {
    return await entry.value;
  }
  const current = async () => {
    try {
      const value = await entry.value;
      return keep(value) ? value : await replaced.value;
    } catch {
      return await replaced.value;
    }
  };
  const elapsed = Promise.withResolvers<null>();
  const timer = setTimeout(() => {
    elapsed.resolve(null);
  }, waitMs);
  const fallback = async () => {
    await elapsed.promise;
    return await replaced.value;
  };
  try {
    return await Promise.race([current(), fallback()]);
  } finally {
    clearTimeout(timer);
  }
};

/**
 * `ttlMs` fresh; with `stale`, an older kept value keeps being served while one background refresh replaces it.
 * A value read at another `generation` (the owner's catalogue revision) is served only to a reader with `waitMs` whose
 * new generation's read has not answered within `waitMs` (as an owner outage would still serve it); otherwise the read
 * waits for its own load.
 */
export const createSharedRead = <A>() => {
  const entries = new Map<string, Entry<A>>();
  const remove = (key: string, entry: Entry<A>) => {
    if (entries.get(key) === entry) {
      entries.delete(key);
    }
    retained.delete(entry);
  };
  const put = (key: string, entry: Entry<A>) => {
    const previous = entries.get(key);
    if (previous !== undefined) {
      retained.delete(previous);
    }
    entries.set(key, entry);
    retained.set(entry, () => remove(key, entry));
    if (retained.size > MAX_ENTRIES) {
      retained.values().next().value?.();
    }
  };
  const refresh = async (
    key: string,
    held: Entry<A>,
    load: (operation: Operation) => Promise<A>,
    keep: (value: A) => boolean,
  ) => {
    held.refreshing = true;
    try {
      const value = await detached(load);
      if (entries.get(key) !== held || !keep(value)) {
        return;
      }
      put(key, {
        at: Date.now(),
        done: true,
        generation: held.generation,
        refreshing: false,
        replaced: null,
        value: Promise.resolve(value),
      });
    } catch {
      // Retain the last kept answer during a temporary owner outage.
    } finally {
      held.refreshing = false;
    }
  };
  const observe = async (key: string, entry: Entry<A>, keep: (value: A) => boolean) => {
    try {
      const result = await entry.value;
      if (keep(result)) {
        entry.done = true;
      } else {
        remove(key, entry);
      }
    } catch {
      remove(key, entry);
    }
  };
  return async (
    key: string,
    ttlMs: number,
    load: (operation: Operation) => Promise<A>,
    {
      caller = {},
      generation,
      keep = () => true,
      stale = false,
      waitMs,
    }: {
      caller?: OperationOptions;
      generation?: number;
      keep?: (value: A) => boolean;
      stale?: boolean;
      waitMs?: number;
    } = {},
  ): Promise<A> => {
    const found = entries.get(key);
    const held = found?.generation === generation ? found : undefined;
    if (held !== undefined) {
      put(key, held);
    }
    if (held !== undefined && (Date.now() - held.at < ttlMs || !held.done)) {
      return await joined(within(held, waitMs, keep), caller);
    }
    if (held !== undefined && stale && Date.now() - held.at < MAX_STALE_MS) {
      if (!held.refreshing) {
        void refresh(key, held, load, keep);
      }
      return await joined(held.value, caller);
    }
    const entry: Entry<A> = {
      at: Date.now(),
      done: false,
      generation,
      refreshing: false,
      replaced: replacedAnswer(found, held),
      value: detached(load),
    };
    put(key, entry);
    void observe(key, entry, keep);
    return await joined(within(entry, waitMs, keep), caller);
  };
};
