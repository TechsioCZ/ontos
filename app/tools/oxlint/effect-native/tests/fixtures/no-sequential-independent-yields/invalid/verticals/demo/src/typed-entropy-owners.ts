// expect-count: 2
import { Effect } from 'effect';
import type { SecureRandom as Entropy } from 'effect/crypto';

type Digest = () => Effect.Effect<string>;
interface Owner { readonly entropy: Entropy.SecureRandom['Service'] }
export const fromParameter = Effect.fn(function* (digest: Digest, source: Entropy.SecureRandom['Service']) {
  const proof = yield* digest();
  const ref = yield* source.uuidV4();
  return { proof, ref };
});
export const fromOwner = Effect.fn(function* (digest: Digest, owner: Owner) {
  const proof = yield* digest();
  const ref = yield* owner.entropy.uuidV7();
  return { proof, ref };
});
