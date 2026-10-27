// expect-count: 2
import { Context, Crypto, Effect, Layer } from 'effect';

class Output extends Context.Service<Output, { readonly send: () => Effect.Effect<Uint8Array> }>()('@fixture/Output') {}

export const shadowedValue = Layer.effect(Output, Effect.gen(function* constructOutput() {
  const crypto = yield* Crypto.Crypto;
  return { send: (crypto: Crypto.Crypto['Service']) => Crypto.randomBytes(4).pipe(Effect.provideService(Crypto.Crypto, crypto)) };
}));

export const shadowedTag = Layer.effect(Output, Effect.gen(function* constructOutput() {
  const crypto = yield* Crypto.Crypto;
  return { send: (Crypto: { readonly Crypto: typeof import('effect').Crypto.Crypto }) => Effect.void.pipe(Effect.provideService(Crypto.Crypto, crypto)) };
}));
