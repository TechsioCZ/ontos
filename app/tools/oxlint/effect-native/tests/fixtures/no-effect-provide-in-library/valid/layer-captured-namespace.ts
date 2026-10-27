import * as Runtime from 'effect';

class Output extends Runtime.Context.Service<Output, { readonly send: () => Runtime.Effect.Effect<Uint8Array> }>()('@fixture/Output') {}

export const live = Runtime.Layer.effect(Output, Runtime.Effect.gen(function* constructOutput() {
  const crypto = yield* Runtime.Crypto.Crypto;
  return { send: () => Runtime.Crypto.randomBytes(4).pipe(Runtime.Effect.provideService(Runtime.Crypto.Crypto, crypto)) };
}));
