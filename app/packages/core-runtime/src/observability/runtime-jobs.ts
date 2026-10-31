import { Clock, Duration, Effect } from 'effect';

/** Fixed infrastructure names and owner module keys only. Never pass request data here. */
export interface RuntimeJobSample {
  readonly durationMs: number;
  readonly finishedAt: number;
  readonly job: string;
  readonly owner: string | undefined;
  readonly startedAt: number;
  readonly thresholdMs: number;
}

declare global {
  /** Installed once by the process host, shared by independently bundled owner runtimes. */
  var ontosRuntimeJobObserver: ((sample: RuntimeJobSample) => void) | undefined;
}

/** Monotonic elapsed time, including failures and interruption, without changing the job's result. */
export const observeRuntimeJob = (job: string, owner?: string, thresholdMs = 200) =>
  Effect.fnUntraced(function* observeJob<Value, Failure, Requirements>(
    effect: Effect.Effect<Value, Failure, Requirements>,
  ) {
    const startedAt = yield* Clock.currentTimeMillis;
    const monotonicStart = yield* Clock.monotonicTimeNanos;
    return yield* effect.pipe(
      Effect.ensuring(
        Effect.gen(function* recordJob() {
          const finishedAt = yield* Clock.currentTimeMillis;
          const monotonicEnd = yield* Clock.monotonicTimeNanos;
          yield* Effect.sync(() => {
            globalThis.ontosRuntimeJobObserver?.({
              durationMs: Duration.toMillis(Duration.nanos(monotonicEnd - monotonicStart)),
              finishedAt,
              job,
              owner,
              startedAt,
              thresholdMs,
            });
          });
        }),
      ),
    );
  });
