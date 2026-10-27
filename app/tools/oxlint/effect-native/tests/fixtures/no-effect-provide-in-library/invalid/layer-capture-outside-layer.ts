// expect-count: 1
import { Context, Crypto, Effect, Layer } from 'effect';

class Output extends Context.Service<Output, { readonly send: () => Effect.Effect<Uint8Array> }>()('@fixture/Output') {}

export const program = Effect.gen(function* constructOutput() {
  const crypto = yield* Crypto.Crypto;
  return { send: () => Crypto.randomBytes(4).pipe(Effect.provideService(Crypto.Crypto, crypto)) };
});
