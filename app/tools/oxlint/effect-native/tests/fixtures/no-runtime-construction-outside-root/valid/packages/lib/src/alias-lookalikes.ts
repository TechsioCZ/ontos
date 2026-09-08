// Local re-bindings that are *not* the effect namespace, and effect aliases used for members that are
// not runtime construction. Following an alias must not widen the rule.
import * as EffectNs from 'effect';
import { Effect, Layer, ManagedRuntime } from 'effect';

declare const appLayer: Layer.Layer<never>;

// An alias of the real namespace, used for a member that builds nothing.
const MR = ManagedRuntime;
export const alive = MR.isManagedRuntime(appLayer);

// A local object that merely borrows the names.
const L = { build: <A>(value: A): A => value, launch: <A>(value: A): A => value };
export const notEffect = L.build(appLayer);

// `Layer.launch` returns `Effect<never, E, RIn>`: it constructs no runtime and stays composable.
export const workerMain = Layer.launch(appLayer);

// A parameter shadowing the barrel is not the import.
export function render(EffectNsParam: { ManagedRuntime: { make: (layer: unknown) => unknown } }): unknown {
  const shadowed = EffectNsParam;
  return shadowed.ManagedRuntime.make(appLayer);
}

export const stillEffect = Effect.gen(function* () {
  return yield* Effect.succeed(EffectNs.Layer.isLayer(appLayer));
});
