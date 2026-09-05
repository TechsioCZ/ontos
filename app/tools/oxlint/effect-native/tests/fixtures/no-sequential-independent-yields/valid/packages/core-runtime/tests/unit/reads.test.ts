// Tests are B2's surface, not B1's: `includeTests` defaults to false.
import { Effect } from 'effect';

declare const alpha: { readonly read: () => Effect.Effect<string> };
declare const beta: { readonly read: () => Effect.Effect<string> };

export const program = Effect.gen(function* () {
  const first = yield* alpha.read();
  const second = yield* beta.read();
  return { first, second };
});
