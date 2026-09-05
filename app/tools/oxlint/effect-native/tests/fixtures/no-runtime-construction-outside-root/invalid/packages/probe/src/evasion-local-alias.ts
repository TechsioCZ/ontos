// expect-count: 2
// Rebinding the effect namespace to a local const is the cheapest possible evasion: the call sites
// below are the identical `ManagedRuntime.make` / `Layer.toRuntime` constructions.
import { Layer, ManagedRuntime } from 'effect';

declare const appLayer: Layer.Layer<never>;

const MR = ManagedRuntime;
const L = Layer;

export const aliasedRuntime = MR.make(appLayer);
export const aliasedBuild = L.toRuntime(appLayer);
