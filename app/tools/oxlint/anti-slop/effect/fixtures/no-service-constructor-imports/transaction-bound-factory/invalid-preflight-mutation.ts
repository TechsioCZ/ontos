// expect-count: 1
import type { ActionServicePreflight } from '@app/core-runtime';
import { Effect } from 'effect';
import { makeStandaloneService } from './owner.ts';

let prepare: ActionServicePreflight<never, unknown, never> = Effect.fn('Owner.prepareServices')(
  function* prepareServices(_payload, _context) {
    const services = yield* makeStandaloneService();
    return () => Effect.succeed(services);
  },
);
void prepare;
