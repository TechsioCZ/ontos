import { Effect, Layer, ManagedRuntime } from 'effect';
const program = Effect.gen(function* () {
  const scope = yield* Effect.scope;
  yield* Layer.build(Layer.empty);
  yield* Layer.buildWithScope(Layer.empty, scope);
});
export const runtime = ManagedRuntime.make(Layer.empty);
void program;
