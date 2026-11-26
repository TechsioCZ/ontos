import "server-only";
import { Effect } from "effect";
import { createOperation } from "@ontos/storefront-runtime";
import type { Operation } from "@ontos/storefront-runtime";

// Process-wide owner reads shared across requests for a short time. Each load runs under its own operation, so one
// shopper's aborted request (header search aborts on every keystroke) never rejects the read for other waiters.
// A rejected read is evicted at once; it is never served.
interface Entry {
  at: number;
  value: Promise<unknown>;
  done: boolean;
  refreshing: boolean;
}
const entries = new Map<string, Entry>();

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

/**
 * `ttlMs` fresh; with `stale`, an older settled value keeps being served while one background refresh replaces it.
 */
export function sharedRead<A>(
  key: string,
  ttlMs: number,
  load: (operation: Operation) => Promise<A>,
  { stale = false, caller }: { stale?: boolean; caller?: Operation } = {},
): Promise<A> {
  return joined(read(key, ttlMs, load, stale), caller);
}

function read<A>(
  key: string,
  ttlMs: number,
  load: (operation: Operation) => Promise<A>,
  stale: boolean,
): Promise<A> {
  const held = entries.get(key);
  if (held !== undefined && (Date.now() - held.at < ttlMs || !held.done))
    return held.value as Promise<A>;
  if (held !== undefined && stale) {
    if (!held.refreshing) {
      held.refreshing = true;
      detached(load).then(
        (value) =>
          entries.set(key, {
            at: Date.now(),
            value: Promise.resolve(value),
            done: true,
            refreshing: false,
          }),
        () => {
          held.refreshing = false;
        },
      );
    }
    return held.value as Promise<A>;
  }
  const value = detached(load);
  const entry: Entry = { at: Date.now(), value, done: false, refreshing: false };
  entries.set(key, entry);
  value.then(
    () => {
      entry.done = true;
    },
    () => {
      if (entries.get(key) === entry) entries.delete(key);
    },
  );
  return value;
}
