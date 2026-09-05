// expect-count: 2
// A chain of local re-bindings: barrel -> const alias -> renamed destructured namespace. Every hop is
// erased at runtime, so both call sites are the same `ManagedRuntime.make(appLayer)`.
import * as EffectNs from 'effect';

declare const appLayer: unknown;

const Aliased = EffectNs;
const { ManagedRuntime: MR } = Aliased;

export const viaAliasedBarrel = Aliased.ManagedRuntime.make(appLayer);
export const viaRenamedNamespace = MR.make(appLayer);
