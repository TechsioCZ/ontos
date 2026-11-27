import "server-only";
import { Effect } from "effect";
import { createOperation } from "@ontos/storefront-runtime";
import type { Operation } from "@ontos/storefront-runtime";
import { isCurrent, liveConnected, nextLiveChange, startLiveChanges } from "./live-changes";
import { joined, MAX_STALE_MS } from "./shared-read";

// An owner read whose answer every visitor shares while that answer is young. With `owners`, an answer is young until
// the Shell's change stream (live-changes.ts) names one of those owners after its read started, for at most a minute:
// the stream reports an admin save within about 300 ms of its commit and the read repeats at once, so the save shows on
// every visit a second later and a visit between saves reads no owner at all. Without the stream (or `owners`) an answer
// is young only while its read started at most `maxAgeMs` ago, so a save shows on every visit that `maxAgeMs` after it.
// While visitors keep coming, and for `keepAliveMs` after the last one, the read repeats in the background, one at a
// time: at each change of its owners (and every 30 s) while the stream is open, otherwise at most every `intervalMs`, so
// a visit takes the newest answer at once instead of waiting for the owner. A visit after a longer quiet waits for its
// own read. When a read fails, visits keep the newest answer for up to 10 minutes, as during an owner outage; a caller
// that cannot wait for a slow read takes that answer too (`latestFreshRead`, or `waitMs`) while the read goes on for the
// visits after it.
interface Answer<A> {
  startedAt: number;
  value: A;
}
interface Pending<A> {
  startedAt: number;
  answer: Promise<Answer<A>>;
}
interface State<A> {
  load: (operation: Operation) => Promise<A>;
  latest?: Answer<A>;
  pending?: Pending<A>;
  demandAt: number;
  polling: boolean;
}
export interface FreshReadTiming {
  maxAgeMs: number;
  intervalMs: number;
  keepAliveMs: number;
  /**
   * A visit waits at most this long for a read that is not young, then takes the newest answer (up to 10 minutes
   * old): an owner that answers in time still shows a save on the first visit, a slow one never holds the visit.
   */
  waitMs?: number;
  /** The owner app ids whose committed changes change the answer (`MERCHANDISE_OWNERS`, `ERP_OWNERS`). */
  owners?: readonly string[];
}
/** An answer the change stream keeps current is still read again this often, and never trusted longer than a minute. */
const STREAM_REREAD_MS = 30_000;
const STREAM_TRUST_MS = 60_000;

/** The answer of a read that started at `startedAt` may still be served at `now`: the stream decides while it is open. */
const holds = (timing: FreshReadTiming, startedAt: number, now: number) =>
  timing.owners !== undefined && liveConnected()
    ? isCurrent(startedAt, timing.owners) && now - startedAt <= STREAM_TRUST_MS
    : now - startedAt <= timing.maxAgeMs;
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
    startedAt,
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
  };
  state.pending = pending;
  return pending;
};

const pause = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms).unref?.());

const poll = async <A>(state: State<A>, timing: FreshReadTiming, owner: number) => {
  if (state.polling) return;
  state.polling = true;
  try {
    while (owner === epoch && Date.now() - state.demandAt < timing.keepAliveMs) {
      const streamed = timing.owners !== undefined && liveConnected();
      const latest = state.latest;
      if (
        streamed &&
        state.pending === undefined &&
        latest !== undefined &&
        isCurrent(latest.startedAt, timing.owners ?? []) &&
        Date.now() - latest.startedAt < STREAM_REREAD_MS
      ) {
        // Current: read again at the next change of its owners (or to renew its trust).
        await nextLiveChange(STREAM_REREAD_MS - (Date.now() - latest.startedAt));
        continue;
      }
      const pending = state.pending ?? start(state);
      const answered = await pending.answer.then(
        () => true,
        () => false,
      );
      // With the stream, an answer outdated by a change during its read is read again at once; a failed read waits.
      if (!streamed || !answered)
        await pause(Math.max(0, timing.intervalMs - (Date.now() - pending.startedAt)));
    }
  } finally {
    state.polling = false;
  }
};

const kept = <A>(state: State<A> | undefined): Answer<A> | undefined => {
  const latest = state?.latest;
  return latest !== undefined && Date.now() - latest.startedAt < MAX_STALE_MS ? latest : undefined;
};

/** The newest answer of `key` that an owner outage would still serve (MAX_STALE_MS), whatever its age otherwise. */
export const latestFreshRead = <A>(key: string): A | undefined =>
  kept(states.get(key) as State<A> | undefined)?.value;

/** `answer`, or after `waitMs` the newest kept answer while the read goes on for the visits after it. */
const within = <A>(answer: Promise<A>, waitMs: number | undefined, state: State<A>): Promise<A> => {
  if (waitMs === undefined || kept(state) === undefined) return answer;
  let timer: ReturnType<typeof setTimeout> | undefined;
  return Promise.race([
    answer,
    new Promise<A>((resolve) => {
      timer = setTimeout(() => {
        const newest = kept(state);
        if (newest !== undefined) resolve(newest.value);
      }, waitMs);
    }),
  ]).finally(() => clearTimeout(timer));
};

export function freshRead<A>(
  key: string,
  timing: FreshReadTiming,
  load: (operation: Operation) => Promise<A>,
  caller: Operation,
): Promise<A> {
  let state = states.get(key) as State<A> | undefined;
  if (state === undefined) {
    state = { load, demandAt: 0, polling: false };
    states.set(key, state as State<unknown>);
  }
  // The newest visit's loader reads for the visits after it (equal keys read the same owner state).
  state.load = load;
  const now = Date.now();
  state.demandAt = now;
  if (timing.owners !== undefined) startLiveChanges();
  void poll(state, timing, epoch);
  const young = (startedAt: number) => holds(timing, startedAt, now);
  if (state.latest !== undefined && young(state.latest.startedAt))
    return Promise.resolve(state.latest.value);
  const pending =
    state.pending !== undefined && young(state.pending.startedAt) ? state.pending : start(state);
  const current = state;
  return joined(
    within(
      pending.answer.then(
        ({ value }) => value,
        (error: unknown) => {
          const newest = kept(current);
          if (newest !== undefined) return newest.value;
          throw error;
        },
      ),
      timing.waitMs,
      current,
    ),
    caller,
  );
}
