// expect-count: 3
// Intersection return type: `EffectBffDefinition<A> & EffectBffRuntime<A>` is still a root.
import type { EffectBffDefinition, EffectBffRuntime } from '@modern-js/plugin-bff/effect-edge';
import { Effect, Layer } from '@modern-js/plugin-bff/effect-edge';

declare const shellApi: unknown;

export function makeShellRuntime(
  authenticationLayer: Layer.Layer<never>,
): EffectBffDefinition<typeof shellApi> & EffectBffRuntime<typeof shellApi> {
  const live = Layer.mergeAll(authenticationLayer);
  void Effect.void;
  return { layer: live } as never;
}
