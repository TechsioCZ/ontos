import { Effect } from 'effect';
import { expect, it } from 'effect-rstest';

import type { PoolResource } from '../../api/auth/db/client.ts';
import { acquirePoolResource } from '../../api/auth/db/client.ts';

it.effect('ends the pool resource without arguments when its scope closes', () =>
  Effect.gen(function* testProgram1() {
    const recorded: number[] = [];
    const fake: PoolResource = {
      end(...args: []) {
        recorded.push(args.length);
        return Promise.resolve();
      },
    };

    const acquired = yield* Effect.scoped(
      Effect.gen(function* acquireResource() {
        const resource = yield* acquirePoolResource(() => fake);
        expect(recorded).toEqual([]);
        return resource;
      }),
    );

    expect(acquired).toBe(fake);
    expect(recorded).toEqual([0]);
  }),
);
