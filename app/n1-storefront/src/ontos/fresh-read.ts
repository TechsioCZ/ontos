import "server-only";
import { Effect } from "effect";
import { createOperation } from "@ontos/storefront-runtime";
import type { Operation, OperationOptions } from "@ontos/storefront-runtime";
import { joined, MAX_STALE_MS } from "./shared-read";

// An owner read whose answer every visitor shares while that answer is young (the AKROS storefront's fresh read): it
// never serves an answer whose read started more than `maxAgeMs` ago, so a state saved in the admin shows on every
// visit that `maxAgeMs` after the save. While visitors keep coming, and for `keepAliveMs` after the last one, the read
// repeats in the background, one at a time and at most every `intervalMs`, so a visit takes the newest answer at once
// instead of waiting for the owner. A visit after a longer quiet waits for its own read. When a read fails, visits keep
// the newest answer for up to 10 minutes, as during an owner outage.
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
  pending?: Pending<A> | undefined;
  polling: boolean;
}
export interface FreshReadTiming {
  intervalMs: number;
  keepAliveMs: number;
  maxAgeMs: number;
}
const states = new Map<string, State<unknown>>();
let epoch = 0;

/** Tests: forget every answer and stop every background read. */
export const clearFreshReads = () => {
  epoch += 1;
  states.clear();
};

const start = <A>(state: State<A>): Pending<A> => {
  const startedAt = Date.now();
  const operation = Effect.runSync(createOperation());
  const pending: Pending<A> = {
    answer: state
      .load(operation)
      .then((value) => {
        const answer = { startedAt, value };
        if (state.latest === undefined || state.latest.startedAt < startedAt) state.latest = answer;
        return answer;
      })
      .finally(() => {
        operation.dispose();
        if (state.pending === pending) state.pending = undefined;
      }),
    startedAt,
  };
  state.pending = pending;
  return pending;
};

const pause = (ms: number) =>
  new Promise<void>((resolve) => {
    // A test DOM may hand back a timer without unref.
    setTimeout(resolve, ms).unref?.();
  });

const poll = async <A>(state: State<A>, timing: FreshReadTiming, owner: number) => {
  if (state.polling) return;
  state.polling = true;
  try {
    while (owner === epoch && Date.now() - state.demandAt < timing.keepAliveMs) {
      const begun = Date.now();
      await (state.pending ?? start(state)).answer.catch(() => undefined);
      await pause(Math.max(0, timing.intervalMs - (Date.now() - begun)));
    }
  } finally {
    state.polling = false;
  }
};

export function freshRead<A>(
  key: string,
  timing: FreshReadTiming,
  load: (operation: Operation) => Promise<A>,
  caller: OperationOptions = {},
): Promise<A> {
  let state = states.get(key) as State<A> | undefined;
  if (state === undefined) {
    state = { demandAt: 0, load, polling: false };
    states.set(key, state as State<unknown>);
  }
  // The newest visit's loader reads for the visits after it (equal keys read the same owner state).
  state.load = load;
  const now = Date.now();
  state.demandAt = now;
  void poll(state, timing, epoch);
  const young = (startedAt: number) => now - startedAt <= timing.maxAgeMs;
  if (state.latest !== undefined && young(state.latest.startedAt))
    return Promise.resolve(state.latest.value);
  const pending =
    state.pending !== undefined && young(state.pending.startedAt) ? state.pending : start(state);
  const current = state;
  return joined(
    pending.answer.then(
      ({ value }) => value,
      (error: unknown) => {
        const kept = current.latest;
        if (kept !== undefined && Date.now() - kept.startedAt < MAX_STALE_MS) return kept.value;
        throw error;
      },
    ),
    caller,
  );
}
