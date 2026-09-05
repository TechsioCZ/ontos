import { Effect, Layer } from 'effect';
import { build, buildWithScope } from 'effect/Layer';
declare const services: Layer.Layer<never>;
export const localContext = Effect.gen(function* () {
  const scope = yield* Effect.scope;
  yield* Layer.build(services);
  yield* build(services);
  yield* buildWithScope(services, scope);
});
export const worker = Layer.launch(services);
// v3-only spelling: capturing an existing runtime is not constructing another one.
export const capture = Effect.runtime;
