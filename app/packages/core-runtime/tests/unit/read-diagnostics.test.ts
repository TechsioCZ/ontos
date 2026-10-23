import { Effect, Ref } from 'effect';
import { TestClock } from 'effect/testing';
import { expect, it } from 'effect-rstest';

import { observeReadPhase, readServerTiming } from '../../src/reads/diagnostics.ts';
import type { ReadTiming } from '../../src/reads/diagnostics.ts';

it.effect('records failed phase duration without changing or logging the failure', () =>
  Effect.gen(function* failedTiming() {
    const entries = yield* Ref.make<readonly ReadTiming[]>([]);
    const failure = { reason: 'private failure' };
    const observed = yield* TestClock.adjust('4 millis').pipe(
      Effect.andThen(Effect.fail(failure)),
      observeReadPhase('read-audit', entries),
      Effect.flip,
    );
    expect(observed).toBe(failure);
    expect(yield* Ref.get(entries)).toEqual([{ durationMs: 4, phase: 'read-audit' }]);
    expect(readServerTiming(yield* Ref.get(entries))).toBe('read-audit;dur=4');
  }),
);

it.effect('keeps simultaneous request collectors separate and remains optional for non-HTTP reads', () =>
  Effect.gen(function* isolatedTimings() {
    const first = yield* Ref.make<readonly ReadTiming[]>([]);
    const second = yield* Ref.make<readonly ReadTiming[]>([]);
    expect(yield* observeReadPhase('read-owner')(Effect.succeed('unobserved'))).toBe('unobserved');
    const values = yield* Effect.all(
      [
        observeReadPhase('read-scope', first)(Effect.succeed('first')),
        observeReadPhase('read-owner', second)(Effect.succeed('second')),
      ],
      { concurrency: 2 },
    );
    expect(values).toEqual(['first', 'second']);
    expect((yield* Ref.get(first)).map(({ phase }) => phase)).toEqual(['read-scope']);
    expect((yield* Ref.get(second)).map(({ phase }) => phase)).toEqual(['read-owner']);
  }),
);
