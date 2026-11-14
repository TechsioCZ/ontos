import { Clock, Effect, Ref, Schema } from 'effect';

/** Fixed names only: timing telemetry contains no query, identity, token or result values. */
const ReadPhaseSchema = Schema.Literals([
  'read-authentication',
  'read-admission',
  'read-scope',
  'read-module',
  'read-permission',
  'read-prepare',
  'read-transaction',
  'read-authority',
  'read-rls',
  'read-owner',
  'read-validation',
  'read-audit',
  'read-encode',
]);
export type ReadPhase = typeof ReadPhaseSchema.Type;

export interface ReadTiming {
  readonly durationMs: number;
  readonly phase: ReadPhase;
}

export const recordReadTiming = (timings: Ref.Ref<readonly ReadTiming[]>, phase: ReadPhase, startedAt: bigint) =>
  Clock.monotonicTimeNanos.pipe(
    Effect.flatMap((finishedAt) =>
      Ref.update(timings, (entries) => [
        ...entries,
        { durationMs: Math.max(0, Math.round(Number(finishedAt - startedAt) / 1000) / 1000), phase },
      ]),
    ),
  );

/** Nested and concurrent phases keep their own durations; they must not be summed as exclusive time. */
export const observeReadPhase = (phase: ReadPhase, timings?: Ref.Ref<readonly ReadTiming[]>) =>
  Effect.fn('ReadTiming.observe')(function* observeReadPhaseEffect<Value, Failure, Requirements>(
    effect: Effect.Effect<Value, Failure, Requirements>,
  ) {
    if (timings === undefined) {
      return yield* effect;
    }
    const startedAt = yield* Clock.monotonicTimeNanos;
    return yield* effect.pipe(Effect.onExit(() => recordReadTiming(timings, phase, startedAt)));
  });

export const readServerTiming = (timings: readonly ReadTiming[]): string =>
  timings.map(({ durationMs, phase }) => `${phase};dur=${durationMs}`).join(', ');
