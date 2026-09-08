// expect-count: 3
// Computed access that is not a plain string Literal: a no-substitution template literal and a
// computed destructuring key reach the same `ManagedRuntime.make` / `Layer.toRuntime` constructors that
// `ManagedRuntime["make"]` already reports.
import { Layer, ManagedRuntime } from 'effect';

declare const appLayer: Layer.Layer<never>;

export const templateComputed = ManagedRuntime[`make`](appLayer);
export const templateComputedOptional = Layer?.[`toRuntime`](appLayer);

const { ['make']: boot } = ManagedRuntime;
export const destructuredComputed = boot(appLayer);
