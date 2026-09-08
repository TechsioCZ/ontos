import { runEffectTestPromise } from '@app/core-runtime/testing/effect-runtime';
import { expect, test } from '@rstest/core';
import { Effect } from 'effect';

import type { PoolResource } from '../../api/auth/db/client.ts';
import { acquirePoolResource } from '../../api/auth/db/client.ts';

test('ends the pool resource without arguments when its scope closes', async () => {
  const recorded: number[] = [];
  const fake: PoolResource = {
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
      })
    )
  );

  expect(acquired).toBe(fake);
  expect(recorded).toEqual([0]);
});
