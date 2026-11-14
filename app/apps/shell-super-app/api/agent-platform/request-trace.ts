/**
 * Where one slow agent-platform request spent its time: fixed phase names, their summed milliseconds and how often
 * each ran, and the caller-authority counts. Never an identity, a token, a cookie or a payload.
 */
import { Clock, Effect, Exit, Ref } from 'effect';

import { emptyCallerAccessTrace } from './caller.ts';
import type { CallerAccessTrace } from './caller.ts';

/** A request slower than this logs one line with every phase. */
export const SLOW_REQUEST_MILLIS = 3000;

export interface RequestPhase {
  readonly count: number;
  readonly ms: number;
}

export interface RequestTrace {
  readonly active: string | null;
  readonly phases: Readonly<Record<string, RequestPhase>>;
}

export interface TracedRequest {
  readonly caller: Ref.Ref<CallerAccessTrace>;
  readonly request: Ref.Ref<RequestTrace>;
  readonly startedAt: number;
}

export const startRequestTrace = Effect.gen(function* startRequestTrace() {
  return {
    caller: yield* Ref.make(emptyCallerAccessTrace),
    request: yield* Ref.make<RequestTrace>({ active: null, phases: {} }),
    startedAt: yield* Clock.currentTimeMillis,
  } satisfies TracedRequest;
});

/** Runs one phase; a phase that runs again (once per decided item) adds to its total. */
export const requestPhase = Effect.fn('AgentPlatform.requestPhase')(function* requestPhase<
  Value,
  Failure,
  Requirements,
>(trace: TracedRequest, phase: string, effect: Effect.Effect<Value, Failure, Requirements>) {
  yield* Ref.update(trace.request, (current) => ({ ...current, active: phase }));
  const startedAt = yield* Clock.currentTimeMillis;
  const value = yield* effect;
  const finishedAt = yield* Clock.currentTimeMillis;
  yield* Ref.update(trace.request, (current) => {
    const previous = current.phases[phase] ?? { count: 0, ms: 0 };
    return {
      active: null,
      phases: { ...current.phases, [phase]: { count: previous.count + 1, ms: previous.ms + finishedAt - startedAt } },
    };
  });
  return value;
});

/** One warning when the request was slow, after it finished or failed; the request's outcome is unchanged. */
export const logSlowRequest = Effect.fn('AgentPlatform.logSlowRequest')(function* logSlowRequest(
  name: string,
  trace: TracedRequest,
  exit: Exit.Exit<unknown, unknown>,
) {
  const totalMs = (yield* Clock.currentTimeMillis) - trace.startedAt;
  if (totalMs <= SLOW_REQUEST_MILLIS) {
    return;
  }
  const request = yield* Ref.get(trace.request);
  const caller = yield* Ref.get(trace.caller);
  const phases = Object.fromEntries(
    Object.entries(request.phases).map(([phase, { count, ms }]) => [`${phase}Ms`, count > 1 ? `${ms}/${count}` : ms]),
  );
  yield* Effect.logWarning(name).pipe(
    Effect.annotateLogs({
      ...phases,
      activePhase: request.active ?? 'none',
      callerActions: caller.actions,
      callerActionsMs: caller.durations.actions ?? null,
      callerCarriers: caller.carriers,
      callerCarriersMs: caller.durations.carriers ?? null,
      callerGateCalls: caller.gateCalls,
      callerLists: caller.lists,
      callerListsMs: caller.durations.lists ?? null,
      callerStatesAfterMs: caller.durations['states-after'] ?? null,
      callerStatesMs: caller.durations.states ?? null,
      outcome: Exit.isSuccess(exit) ? 'ok' : 'failed',
      totalMs,
    }),
  );
});

/** Runs a request with its trace and logs it once when slow. */
export const withRequestTrace = Effect.fn('AgentPlatform.withRequestTrace')(function* withRequestTrace<
  Value,
  Failure,
  Requirements,
>(name: string, body: (trace: TracedRequest) => Effect.Effect<Value, Failure, Requirements>) {
  const trace = yield* startRequestTrace;
  return yield* body(trace).pipe(Effect.onExit((exit) => logSlowRequest(name, trace, exit)));
});
