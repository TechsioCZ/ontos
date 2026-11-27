// expect-count: 1
import { Effect } from 'effect';
import { SecureRandom } from 'effect/crypto';

declare const firstReader: { readonly read: () => Effect.Effect<string> };
declare const secondReader: { readonly read: () => Effect.Effect<string> };

export const program = Effect.gen(function* () {
  const entropy = yield* SecureRandom.SecureRandom;
  const reference = yield* entropy.uuidV4();
  const first = yield* firstReader.read();
  const second = yield* secondReader.read();
  return { first, reference, second };
});
