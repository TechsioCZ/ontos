import { runEffectTestPromise } from '@app/core-runtime/testing/effect-runtime';
import { expect, test } from '@rstest/core';
import { Effect } from 'effect';
import type { PoolResource } from '../../api/auth/db/client.ts';
import { acquirePoolResource } from '../../api/auth/db/client.ts';

test('ends the pool resource without arguments when its scope closes', async () => {
  const recorded: number[] = [];
  const fake: PoolResource = {
    // oxlint-disable-next-line effect-native/no-promise-shaped-port -- This fixture implements pg Pool.end's foreign Promise API.
    async end(...args: []) {
      recorded.push(args.length);
    },
  };

  const acquired = await runEffectTestPromise(
    Effect.scoped(
      Effect.gen(function* acquireResource() {
        const resource = yield* acquirePoolResource(() => fake);
        expect(recorded).toEqual([]);
        return resource;
      }),
    ),
  );

  expect(acquired).toBe(fake);
  expect(recorded).toEqual([0]);
});
