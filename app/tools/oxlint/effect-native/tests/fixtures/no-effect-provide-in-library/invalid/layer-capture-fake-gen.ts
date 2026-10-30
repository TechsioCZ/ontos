// expect-count: 1
import { Context, Crypto, Effect, Layer } from 'effect';

class Output extends Context.Service<Output, { readonly send: () => Effect.Effect<Uint8Array> }>()('@fixture/Output') {}

const fake = { gen: (body: () => Generator) => body };
export const live = Layer.effect(Output, fake.gen(function* constructOutput() {
  const crypto = yield* Crypto.Crypto;
  return { send: () => Crypto.randomBytes(4).pipe(Effect.provideService(Crypto.Crypto, crypto)) };
}));
