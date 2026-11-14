import { Layer, Logger, ManagedRuntime, References, Tracer } from 'effect';
import { FetchHttpClient } from 'effect/http';

const browserTracer = Tracer.make({ span: (options) => new Tracer.NativeSpan(options) });
export const browserRuntime = ManagedRuntime.make(
  Layer.mergeAll(
    Logger.layer([Logger.defaultLogger]),
    Layer.succeed(Tracer.Tracer, browserTracer),
    Layer.succeed(References.MinimumLogLevel, 'Info'),
    FetchHttpClient.layer,
  ),
);
