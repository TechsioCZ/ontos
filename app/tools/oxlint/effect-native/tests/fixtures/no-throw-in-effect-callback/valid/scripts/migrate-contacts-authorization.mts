// `scripts/**` throws belong to B3 / `no-throw-in-scripts`, never to S1/A4.
import { Effect } from 'effect';

export const migrate = Effect.gen(function* () {
  yield* Effect.log('migrating');
  throw new Error('missing --tenant argument');
});
