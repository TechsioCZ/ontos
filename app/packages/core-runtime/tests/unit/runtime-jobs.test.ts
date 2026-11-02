import { Effect, Exit } from 'effect';
import { expect, it } from 'effect-rstest';

import { observeRuntimeJob } from '../../src/observability/runtime-jobs.ts';
import type { RuntimeJobSample } from '../../src/observability/runtime-jobs.ts';

it.effect('records completion and typed failure without changing either result', () =>
  Effect.gen(function* observedJob() {
    const samples: RuntimeJobSample[] = [];
    yield* Effect.acquireRelease(
      Effect.sync(() => {
        globalThis.ontosRuntimeJobObserver = (sample) => {
          samples.push(sample);
        };
      }),
      () =>
        Effect.sync(() => {
          Reflect.deleteProperty(globalThis, 'ontosRuntimeJobObserver');
        }),
    );
    expect(yield* Effect.succeed(42).pipe(observeRuntimeJob('outbox-poll', 'fixture-owner'))).toBe(42);
    expect(yield* Effect.fail('fixture-failure').pipe(observeRuntimeJob('outbox-poll'), Effect.exit)).toEqual(
      Exit.fail('fixture-failure'),
    );
    expect(samples).toHaveLength(2);
    expect(samples[0]).toMatchObject({ durationMs: 0, job: 'outbox-poll', owner: 'fixture-owner', thresholdMs: 200 });
  }).pipe(Effect.scoped),
);
