// False positive: ambient/`declare` signatures are type positions only. A `declare const`,
// a `declare function` and an `abstract` method cannot install a Layer — there is no body and no
// value at all — so none of them is a runtime root. `EffectRuntimeLayer` is additionally a *Layer*
// type (`Layer.Layer<never, never, EffectRuntimeRequirements>`), not a runtime, so a function that
// returns one is a layer factory, not a composition root.
import type { EffectBffRuntime, EffectRuntimeLayer } from '@modern-js/plugin-bff/effect-edge';

declare const demoApi: unknown;

export declare const makeDemoRuntime: (auth: never) => EffectBffRuntime<typeof demoApi>;

export declare function makeOtherRuntime(auth: never): EffectBffRuntime<typeof demoApi>;

export abstract class RuntimeFactoryBase {
  abstract makeRuntime(auth: never): EffectBffRuntime<typeof demoApi>;
}

export declare function makeDemoLayer(): EffectRuntimeLayer;
