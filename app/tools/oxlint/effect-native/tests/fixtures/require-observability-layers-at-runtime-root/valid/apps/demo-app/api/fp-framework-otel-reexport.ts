// False positive: this root DOES install a Tracer. `@modern-js/plugin-bff/effect-server`
// (`./server`, `./effect`, `./effect-server` all resolve to the same entry) contains
// `export * as OpenTelemetry from '@effect/opentelemetry'`, so `OpenTelemetry.NodeSdk.layer(...)`
// is the framework-sanctioned way to install OTel in this codebase. `otelModules` only matches the
// raw `@effect/opentelemetry` specifier and `reexportModules` lists only `.../effect-edge`, so the
// rule reports `missingTracer` on a fully compliant root.
import { Layer, Logger, ManagedRuntime, References } from 'effect';
import { OpenTelemetry } from '@modern-js/plugin-bff/effect-server';

declare const appLayer: Layer.Layer<never>;

const observability = Layer.mergeAll(
  Logger.layer([Logger.consoleJson]),
  OpenTelemetry.NodeSdk.layer(() => ({ resource: { serviceName: 'demo-app' } })),
  Layer.succeed(References.MinimumLogLevel, 'Info'),
);

export const runtime = ManagedRuntime.make(Layer.provideMerge(appLayer, observability));
