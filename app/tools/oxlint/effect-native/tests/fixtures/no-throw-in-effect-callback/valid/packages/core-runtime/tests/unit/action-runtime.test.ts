// Tests are out of scope by default (`includeTests: false`); B2 owns the harness migration.
import { Effect } from 'effect';

export const failing = Effect.gen(function* () {
  yield* Effect.log('arrange');
  throw new Error('deliberately malformed fixture');
});
