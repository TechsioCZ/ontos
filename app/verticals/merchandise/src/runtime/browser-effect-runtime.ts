import { Layer, Logger, ManagedRuntime, References, Tracer } from 'effect';
import { FetchHttpClient } from 'effect/unstable/http';

const browserTracer = Tracer.make({ span: (options) => new Tracer.NativeSpan(options) });
export const browserRuntime = ManagedRuntime.make(
  Layer.mergeAll(
    FetchHttpClient.layer,
    Layer.succeed(FetchHttpClient.RequestInit, { cache: 'no-store', credentials: 'include' }),
    Logger.layer([Logger.defaultLogger]),
    Layer.succeed(Tracer.Tracer, browserTracer),
    Layer.succeed(References.MinimumLogLevel, 'Info'),
  ),
);
