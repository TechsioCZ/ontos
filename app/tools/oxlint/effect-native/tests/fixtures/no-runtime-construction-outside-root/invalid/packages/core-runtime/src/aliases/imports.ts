// expect-count: 6
// Every import spelling of the same construction must be caught.
import { ManagedRuntime as MR, Layer as L } from 'effect';
import * as ManagedRuntimeNs from 'effect/ManagedRuntime';
import * as EffectNs from 'effect';
import { make as bootRuntime } from 'effect/ManagedRuntime';

declare const appLayer: L.Layer<never>;
declare const pipe: <A>(a: A, ...fs: ReadonlyArray<(a: never) => never>) => A;

export const aliased = MR.make(appLayer);
export const namespaced = ManagedRuntimeNs.make(appLayer);
export const computed = ManagedRuntimeNs['make'](appLayer);
export const viaBarrel = EffectNs.ManagedRuntime.make(appLayer);
export const direct = bootRuntime(appLayer);
export const pointFree = pipe(appLayer, L.toRuntime);
