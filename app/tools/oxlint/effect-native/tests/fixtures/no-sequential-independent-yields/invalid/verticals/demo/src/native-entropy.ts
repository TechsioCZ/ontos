// expect-count: 1
import { Effect } from 'effect';
import { SecureRandom } from 'effect/crypto';

declare const digestProof: () => Effect.Effect<string>;

export const program = Effect.gen(function* () {
  const entropy = yield* SecureRandom.SecureRandom;
  const digest = yield* digestProof();
  const reference = yield* entropy.uuidV4();
  return { digest, reference };
});
