// expect-count: 3
// The namespace identifier wrapped in a type-only expression (`as`, `satisfies`, `!`) is erased at
// runtime: these are byte-for-byte the same construction as `ManagedRuntime.make(appLayer)`.
import { Layer, ManagedRuntime } from 'effect';

declare const appLayer: Layer.Layer<never>;

export const viaAs = (ManagedRuntime as typeof ManagedRuntime).make(appLayer);
export const viaSatisfies = (Layer satisfies typeof Layer).toRuntime(appLayer);
export const viaNonNull = ManagedRuntime!.make(appLayer);
