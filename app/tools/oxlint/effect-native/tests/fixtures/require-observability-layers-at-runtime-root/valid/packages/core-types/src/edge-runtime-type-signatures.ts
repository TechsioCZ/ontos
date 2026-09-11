// Pure type declarations: a factory *signature* installs nothing and is not a runtime root.
import type { EffectBffRuntime } from '@modern-js/bff-effect/effect-edge';

declare const demoApi: unknown;

export type MakeDemoRuntime = (auth: never) => EffectBffRuntime<typeof demoApi>;

export interface RuntimeFactories {
  makeDemoRuntime(auth: never): EffectBffRuntime<typeof demoApi>;
}
