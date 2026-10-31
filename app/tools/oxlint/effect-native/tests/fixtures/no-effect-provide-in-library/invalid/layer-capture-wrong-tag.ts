// expect-count: 1
import { Context, Effect, Layer } from 'effect';

class A extends Context.Service<A, { readonly value: number }>()('@fixture/A') {}
class B extends Context.Service<B, { readonly value: number }>()('@fixture/B') {}
class Output extends Context.Service<Output, { readonly send: () => Effect.Effect<number> }>()('@fixture/Output') {}
export const live = Layer.effect(Output, Effect.gen(function* constructOutput() {
  const captured = yield* A;
  return { send: () => B.pipe(Effect.map((service) => service.value), Effect.provideService(B, captured)) };
}));
