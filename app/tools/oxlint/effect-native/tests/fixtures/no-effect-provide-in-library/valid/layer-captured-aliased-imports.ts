import { Context, Crypto as Cryptography, Effect as Fx, Layer as L } from 'effect';

class Output extends Context.Service<Output, { readonly send: () => Fx.Effect<Uint8Array> }>()('@fixture/Output') {}

export const live = L.effect(Output, Fx.gen(function* constructOutput() {
  const captured = yield* Cryptography.Crypto;
  return { send: () => Cryptography.randomBytes(4).pipe(Fx.provideService(Cryptography.Crypto, captured)) };
}));
