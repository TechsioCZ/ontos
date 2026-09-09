import { Effect, Schema } from 'effect';
import { expect, it } from 'effect-rstest';

import { purgeFixtureRows } from '../support/fixture-cleanup.ts';

class FixtureDeletionError extends Schema.TaggedError<FixtureDeletionError>()('FixtureDeletionError', {}) {}

it.effect('purges fixture rows sequentially in child-before-parent order', () =>
  Effect.gen(function* verifyDeletionOrder() {
    const deleted: string[] = [];
    yield* purgeFixtureRows([
      Effect.yieldNow.pipe(
        Effect.andThen(
          Effect.sync(() => {
            deleted.push('child');
          }),
        ),
      ),
      Effect.sync(() => {
        expect(deleted).toEqual(['child']);
        deleted.push('parent');
      }),
    ]);
    expect(deleted).toEqual(['child', 'parent']);
  }),
);

it.effect('stops fixture cleanup at the first failed deletion', () =>
  Effect.gen(function* verifyFirstFailure() {
    const deleted: string[] = [];
    const failure = new FixtureDeletionError();
    const error = yield* purgeFixtureRows([
      Effect.sync(() => {
        deleted.push('child');
      }),
      Effect.fail(failure),
      Effect.sync(() => {
        deleted.push('parent');
      }),
    ]).pipe(Effect.flip);
    expect(error).toBe(failure);
    expect(deleted).toEqual(['child']);
  }),
);

it.effect('accepts an empty fixture cleanup', () =>
  Effect.gen(function* verifyEmptyCleanup() {
    const result = yield* purgeFixtureRows<never, never>([]);
    expect(result).toBe(undefined);
  }),
);
