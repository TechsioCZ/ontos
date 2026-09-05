// Root namespace import (`import * as EffectNs from "effect"`) on both the root and the evidence.
import type { EffectBffRuntime } from '@modern-js/plugin-bff/effect-edge';
import * as EffectNs from 'effect';
import * as Otel from '@effect/opentelemetry';

declare const demoApi: unknown;

export const makeDemoApiRuntime = (
  base: EffectNs.Layer.Layer<never>,
): EffectBffRuntime<typeof demoApi> => {
  const observability = EffectNs.Layer.mergeAll(
    Otel.OtelLogger.layer,
    Otel.NodeSdk.layer(() => ({ resource: { serviceName: 'demo' } })),
    EffectNs.Layer.succeed(EffectNs.References.MinimumLogLevel, 'Info'),
  );
  return { layer: EffectNs.Layer.provide(base, observability) } as never;
};
