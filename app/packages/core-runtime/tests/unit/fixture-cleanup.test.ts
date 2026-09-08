import assert from 'node:assert/strict';
import { test } from 'node:test';

import { Effect, Schema } from 'effect';

import { makeEffectTestCallback } from '../support/effect-runtime.ts';
import { purgeFixtureRows } from '../support/fixture-cleanup.ts';

class FixtureDeletionError extends Schema.TaggedError<FixtureDeletionError>()(
  'FixtureDeletionError',
  {}
) {}

void test(
  'purges fixture rows sequentially in child-before-parent order',
  makeEffectTestCallback(
    Effect.gen(function* verifyDeletionOrder() {
      const deleted: string[] = [];
      yield* purgeFixtureRows([
        Effect.yieldNow.pipe(
          Effect.andThen(
            Effect.sync(() => {
              deleted.push('child');
            })
          )
        ),
        Effect.sync(() => {
          assert.deepEqual(deleted, ['child']);
          deleted.push('parent');
        }),
      ]);
      assert.deepEqual(deleted, ['child', 'parent']);
    })
  )
);

void test(
  'stops fixture cleanup at the first failed deletion',
  makeEffectTestCallback(
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
      assert.equal(error, failure);
      assert.deepEqual(deleted, ['child']);
    })
  )
);

void test(
  'accepts an empty fixture cleanup',
  makeEffectTestCallback(
    Effect.gen(function* verifyEmptyCleanup() {
      const result = yield* purgeFixtureRows<never, never>([]);
      assert.equal(result, undefined);
    })
  )
);
