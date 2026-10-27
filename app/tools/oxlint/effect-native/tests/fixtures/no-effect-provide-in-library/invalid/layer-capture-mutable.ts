// expect-count: 3
import { Context, Crypto, Effect, Layer } from 'effect';

class Output extends Context.Service<Output, { readonly send: () => Effect.Effect<Uint8Array> }>()('@fixture/Output') {}

export const mutableValue = Layer.effect(Output, Effect.gen(function* constructOutput() {
  let crypto = yield* Crypto.Crypto;
  return { send: () => Crypto.randomBytes(4).pipe(Effect.provideService(Crypto.Crypto, crypto)) };
}));

let Tag = Crypto.Crypto;
export const mutableTag = Layer.effect(Output, Effect.gen(function* constructOutput() {
  const captured = yield* Tag;
  return { send: () => Crypto.randomBytes(4).pipe(Effect.provideService(Tag, captured)) };
}));

const Factory = Layer;
Factory.effect = () => undefined;
export const mutatedFactory = Factory.effect(Output, Effect.gen(function* constructOutput() {
  const captured = yield* Crypto.Crypto;
  return { send: () => Crypto.randomBytes(4).pipe(Effect.provideService(Crypto.Crypto, captured)) };
}));
