// expect-count: 2
// Pulling the namespace off the root barrel with a destructuring pattern instead of
// `EffectNs.ManagedRuntime.make` — the barrel form is already reported, this one is not.
import * as EffectNs from 'effect';

declare const appLayer: unknown;

const { ManagedRuntime, Layer } = EffectNs;

export const runtime = ManagedRuntime.make(appLayer);
export const built = Layer.toRuntime(appLayer);
