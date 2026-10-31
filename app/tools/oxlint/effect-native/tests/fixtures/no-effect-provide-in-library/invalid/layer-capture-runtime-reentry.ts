// expect-count: 3
import { Context, Crypto, Effect, Layer } from 'effect';

class Output extends Context.Service<Output, { readonly send: () => Effect.Effect<Uint8Array> }>()('@fixture/Output') {}

import { runPromise as run } from 'effect/Effect';

export const nestedRuntime = Layer.effect(Output, Effect.gen(function* constructOutput() {
  const crypto = yield* Crypto.Crypto;
  return { send: () => Effect.promise(() => Effect.runPromise(Crypto.randomBytes(4).pipe(Effect.provideService(Crypto.Crypto, crypto)))) };
}));

export const importedRuntime = Layer.effect(Output, Effect.gen(function* constructOutput() {
  const crypto = yield* Crypto.Crypto;
  return { send: () => Effect.promise(() => run(Crypto.randomBytes(4).pipe(Effect.provideService(Crypto.Crypto, crypto)))) };
}));

const { runPromise: enter } = Effect;
export const aliasedRuntime = Layer.effect(Output, Effect.gen(function* constructOutput() {
  const crypto = yield* Crypto.Crypto;
  return { send: () => Effect.promise(() => enter(Crypto.randomBytes(4).pipe(Effect.provideService(Crypto.Crypto, crypto)))) };
}));
