// expect-count: 2
import { Context, Crypto, Effect, Layer } from 'effect';

class Output extends Context.Service<Output, { readonly send: () => Effect.Effect<Uint8Array> }>()('@fixture/Output') {}

export const duringConstruction = Layer.effect(Output, Effect.gen(function* constructOutput() {
  const crypto = yield* Crypto.Crypto;
  const bytes = yield* Crypto.randomBytes(4).pipe(Effect.provideService(Crypto.Crypto, crypto));
  return { send: () => Effect.succeed(bytes) };
}));

export const nestedAcquisition = Layer.effect(Output, Effect.gen(function* constructOutput() {
  return { send: () => Effect.gen(function* send() {
    const crypto = yield* Crypto.Crypto;
    return yield* Crypto.randomBytes(4).pipe(Effect.provideService(Crypto.Crypto, crypto));
  }) };
}));
