// expect-count: 3
// The BFF factory return type marks this as a composition root.
import type { EffectBffRuntime } from '@modern-js/plugin-bff/effect-edge';
import { Layer } from 'effect';

declare const demoApi: unknown;

export const makeDemoApiRuntime = (
  auth: Layer.Layer<never>,
): EffectBffRuntime<typeof demoApi> => {
  const composed = Layer.mergeAll(auth);
  return { layer: composed } as unknown as EffectBffRuntime<typeof demoApi>;
};
