import "server-only";
import { Effect } from "effect";
import { createOperation } from "@ontos/storefront-runtime";
import type { Operation, OperationOptions } from "@ontos/storefront-runtime";
import { joined, MAX_STALE_MS } from "./shared-read";
import { storefrontRuntime } from "./runtime";

// An owner read whose answer every visitor shares while that answer is young (the AKROS storefront's fresh read): it
// never serves an answer whose read started more than `maxAgeMs` ago, so a state saved in the admin shows on every
// visit that `maxAgeMs` after the save. While visitors keep coming, and for `keepAliveMs` after the last one, the read
// repeats in the background, one at a time and at most every `intervalMs`, so a visit takes the newest answer at once
// instead of waiting for the owner. A visit after a longer quiet waits for its own read. When a read fails, visits keep
// the newest answer for up to 10 minutes, as during an owner outage; with `waitMs` a visit that cannot wait for a slow read
// takes that answer too while the read goes on for the visits after it.
interface Answer<A> {
  startedAt: number;
  value: A;
}
interface Pending<A> {
  answer: Promise<Answer<A>>;
  startedAt: number;
}
interface State<A> {
  demandAt: number;
  latest?: Answer<A>;
  load: (operation: Operation) => Promise<A>;
  pending?: Pending<A>;
  polling: boolean;
}
export interface FreshReadTiming {
  intervalMs: number;
  keepAliveMs: number;
  maxAgeMs: number;
  /**
   * A visit waits at most this long for a read that is not young, then takes the newest answer (up to 10 minutes
   * old): an owner that answers in time still shows a save on the first visit, a slow one never holds the visit.
   */
  waitMs?: number;
}
let epoch = 0;

/** Tests: forget every answer and stop every background read. */
export const clearFreshReads = () => {
  epoch += 1;
};

const readAnswer = async <A>(state: State<A>, startedAt: number) => {
  const operation = storefrontRuntime.runSync(createOperation());
  try {
    const value = await state.load(operation);
    const answer = { startedAt, value };
    if (state.latest === undefined || state.latest.startedAt < startedAt) {
      state.latest = answer;
    }
    return answer;
  } finally {
    operation.dispose();
  }
};
const clearPending = async <A>(state: State<A>, pending: Pending<A>) => {
  try {
    await pending.answer;
  } catch {
    // The visitor handles read failure; this observer only releases the matching slot.
  } finally {
    if (state.pending === pending) {
      delete state.pending;
    }
  }
};
const start = <A>(state: State<A>): Pending<A> => {
  const startedAt = Date.now();
  const pending = { answer: readAnswer(state, startedAt), startedAt };
  state.pending = pending;
  void clearPending(state, pending);
  return pending;
};
const pause = async (ms: number) => {
  const elapsed = Promise.withResolvers<null>();
  // A test DOM may hand back a timer without unref.
  setTimeout(() => {
    elapsed.resolve(null);
  }, ms).unref?.();
  await elapsed.promise;
};
const poll = <A>(state: State<A>, timing: FreshReadTiming, owner: number) => {
  if (state.polling) {
    return;
  }
  state.polling = true;
  const iteration = Effect.gen(function* refreshAnswer() {
    const begun = Date.now();
    yield* Effect.promise(async () => {
      try {
        await (state.pending ?? start(state)).answer;
      } catch {
        // Keep the newest successful answer during a temporary owner outage.
      }
    });
    yield* Effect.promise(
      async () => await pause(Math.max(0, timing.intervalMs - (Date.now() - begun))),
    );
  });
  storefrontRuntime.runFork(
    Effect.whileLoop({
      body: () => iteration,
      step: () => {
        // Each iteration updates its own pending state.
      },
      while: () => owner === epoch && Date.now() - state.demandAt < timing.keepAliveMs,
    }).pipe(
      Effect.ensuring(
        Effect.sync(() => {
          state.polling = false;
        }),
      ),
    ),
  );
};

const kept = <A>(state: State<A>): Answer<A> | undefined => {
  const { latest } = state;
  return latest !== undefined && Date.now() - latest.startedAt < MAX_STALE_MS ? latest : undefined;
};

/** `answer`, or after `waitMs` the newest kept answer while the read goes on for the visits after it. */
const within = async <A>(
  answer: Promise<A>,
  waitMs: number | undefined,
  state: State<A>,
): Promise<A> => {
  if (waitMs === undefined || kept(state) === undefined) {
    return await answer;
  }
  const fallback = Promise.withResolvers<A>();
  const timer = setTimeout(() => {
    const newest = kept(state);
    if (newest !== undefined) {
      fallback.resolve(newest.value);
    }
  }, waitMs);
  try {
    return await Promise.race([answer, fallback.promise]);
  } finally {
    clearTimeout(timer);
  }
};
const newestAnswer = async <A>(pending: Pending<A>, state: State<A>) => {
  try {
    const answer = await pending.answer;
    return answer.value;
  } catch (error) {
    const newest = kept(state);
    if (newest !== undefined) {
      return newest.value;
    }
    throw error;
  }
};

/** Typed owner read family with the original freshness and bounded-stale guarantees. */
export const createFreshRead = <A>() => {
  const states = new Map<string, State<A>>();
  let owner = epoch;
  return async (
    key: string,
    timing: FreshReadTiming,
    load: (operation: Operation) => Promise<A>,
    caller: OperationOptions = {},
  ): Promise<A> => {
    if (owner !== epoch) {
      states.clear();
      owner = epoch;
    }
    let state = states.get(key);
    if (state === undefined) {
      state = { demandAt: 0, load, polling: false };
      states.set(key, state);
    }
    state.load = load;
    const now = Date.now();
    state.demandAt = now;
    poll(state, timing, owner);
    const young = (startedAt: number) => now - startedAt <= timing.maxAgeMs;
    if (state.latest !== undefined && young(state.latest.startedAt)) {
      return state.latest.value;
    }
    const pending =
      state.pending !== undefined && young(state.pending.startedAt) ? state.pending : start(state);
    return await joined(within(newestAnswer(pending, state), timing.waitMs, state), caller);
  };
};
