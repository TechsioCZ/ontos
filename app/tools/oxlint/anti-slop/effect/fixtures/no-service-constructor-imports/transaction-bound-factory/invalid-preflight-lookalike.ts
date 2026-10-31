// expect-count: 1
type ActionServicePreflight<Payload, Services, Failure> = (_payload: Payload, _context: unknown) => unknown;
import { Effect } from 'effect';
import { makeStandaloneService } from './owner.ts';

const prepare: ActionServicePreflight<never, unknown, never> = Effect.fn('Owner.prepareServices')(
  function* prepareServices(_payload, _context) {
    const services = yield* makeStandaloneService();
    return () => Effect.succeed(services);
  },
);
void prepare;
