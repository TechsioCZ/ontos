// The A6 target shape: Logger + OTel tracer + MinimumLogLevel composed once at the root.
import { NodeSdk } from '@effect/opentelemetry';
import { Layer, Logger, ManagedRuntime, References } from 'effect';

declare const appLayer: Layer.Layer<never>;

const observability = Layer.mergeAll(
  Logger.layer([Logger.consoleJson]),
  NodeSdk.layer(() => ({ resource: { serviceName: 'ontos' } })),
  Layer.succeed(References.MinimumLogLevel, 'Info'),
);

export const runtime = ManagedRuntime.make(Layer.provide(appLayer, observability));
