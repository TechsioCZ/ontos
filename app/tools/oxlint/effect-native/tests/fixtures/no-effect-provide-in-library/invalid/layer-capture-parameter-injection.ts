// expect-count: 2
import { Context, Crypto, Effect, Layer } from 'effect';

class Output extends Context.Service<Output, { readonly send: () => Effect.Effect<Uint8Array> }>()('@fixture/Output') {}

export const injectedValue = (crypto: Crypto.Crypto['Service']) => Layer.effect(Output, Effect.gen(function* constructOutput() {
  return { send: () => Crypto.randomBytes(4).pipe(Effect.provideService(Crypto.Crypto, crypto)) };
}));

export const injectedTag = (Tag: typeof Crypto.Crypto) => Layer.effect(Output, Effect.gen(function* constructOutput() {
  const captured = yield* Tag;
  return { send: () => Crypto.randomBytes(4).pipe(Effect.provideService(Tag, captured)) };
}));
