import { NodeRuntime, NodeServices } from '@effect/platform-node';
import { Console, Duration, Effect, Schema } from 'effect';
import { Command, Flag } from 'effect/cli';

import { TARGETS, probeTarget } from '../../../.github/workflows/support/stage-availability.mjs';

const TargetSchema = Schema.Struct({
  label: Schema.String,
  storefront: Schema.optionalKey(Schema.Boolean),
  url: Schema.String,
});
type Target = typeof TargetSchema.Type;
const ProbeResultSchema = Schema.Struct({ label: Schema.String, problems: Schema.Array(Schema.String) });
type ProbeResult = typeof ProbeResultSchema.Type;
const ReportSchema = Schema.Struct({
  durationMs: Schema.Struct({
    burst: Schema.Number,
    max: Schema.Number,
    median: Schema.Number,
    min: Schema.Number,
  }),
  failed: Schema.Int,
  label: Schema.String,
  passed: Schema.Int,
  problems: Schema.Array(Schema.String),
  requests: Schema.Int,
  warmProblems: Schema.Array(Schema.String),
});
const probeFailed = 'probe-failed';
class CapacityProbeFailure extends Schema.TaggedError<CapacityProbeFailure>()('CapacityProbeFailure', {
  reason: Schema.Literals(['invalid-concurrency', probeFailed]),
}) {}

// Reuse the independent public availability contract at its existing Promise driver boundary.
const publicProbe = (target: Target) =>
  Effect.tryPromise({
    catch: () => new CapacityProbeFailure({ reason: probeFailed }),
    try: async () => await probeTarget(target),
  }).pipe(Effect.flatMap(Schema.decodeUnknownEffect(ProbeResultSchema)));

const targetBurst = <E, R>(
  target: Target,
  concurrency: number,
  probe: (target: Target) => Effect.Effect<ProbeResult, E, R>,
) =>
  Effect.gen(function* measuredTargetBurst() {
    const warm = yield* probe(target);
    const [burstDuration, replies] = yield* Effect.forEach(
      Array.from({ length: concurrency }),
      () =>
        probe(target).pipe(
          Effect.timed,
          Effect.map(([duration, reply]) => ({ ...reply, elapsedMs: Duration.toMillis(duration) })),
        ),
      { concurrency },
    ).pipe(Effect.timed);
    const durations = replies.map((reply) => reply.elapsedMs).toSorted((left, right) => left - right);
    const failures = replies.filter((reply) => reply.problems.length > 0);
    return {
      durationMs: {
        burst: Duration.toMillis(burstDuration),
        max: Math.max(...durations),
        median: durations[Math.floor(durations.length / 2)],
        min: Math.min(...durations),
      },
      failed: failures.length,
      label: target.label,
      passed: replies.length - failures.length,
      problems: [...new Set(failures.flatMap((reply) => reply.problems))],
      requests: concurrency,
      warmProblems: warm.problems,
    };
  });

/** Fixed-target, bounded read-only acceptance. Durations are diagnostics, not a speed benchmark. */
export const probeCapacity = <E, R>({
  concurrency,
  probe,
}: {
  readonly concurrency: number;
  readonly probe: (target: Target) => Effect.Effect<ProbeResult, E, R>;
}) =>
  Effect.gen(function* capacityProgram() {
    if (!Number.isSafeInteger(concurrency) || concurrency < 1 || concurrency > 32) {
      return yield* new CapacityProbeFailure({ reason: 'invalid-concurrency' });
    }
    const targets = yield* Schema.decodeUnknownEffect(Schema.Array(TargetSchema))(TARGETS);
    return yield* Effect.forEach(
      targets.filter((target) => target.storefront === true),
      (target) => targetBurst(target, concurrency, probe),
      { concurrency: 1 },
    );
  });

const command = Command.make(
  'stage-storefront-capacity',
  { burst32: Flag.Boolean('burst32').pipe(Flag.withDefault(false)) },
  ({ burst32 }) =>
    Effect.gen(function* publicAcceptance() {
      const reports = yield* probeCapacity({ concurrency: burst32 ? 32 : 4, probe: publicProbe });
      for (const report of reports) {
        yield* Console.log(yield* Schema.encodeEffect(Schema.fromJsonString(ReportSchema))(report));
      }
      if (reports.some((report) => report.failed > 0 || report.warmProblems.length > 0)) {
        return yield* new CapacityProbeFailure({ reason: probeFailed });
      }
      return yield* Effect.void;
    }),
);
if (import.meta.main) {
  NodeRuntime.runMain(Command.run(command, { version: '1.0.0' }).pipe(Effect.provide(NodeServices.layer)));
}
