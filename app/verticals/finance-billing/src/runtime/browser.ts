import { Layer, Logger, ManagedRuntime, References, Tracer } from 'effect';
import { FetchHttpClient } from 'effect/http';

// One owner browser driver owns fibers for every finance read and mutation.
export const financeBrowserRuntime = ManagedRuntime.make(
  Layer.mergeAll(
    FetchHttpClient.layer,
    Logger.layer([Logger.defaultLogger, Logger.tracerLogger]),
    Layer.succeed(Tracer.Tracer, Tracer.make({ span: (options) => new Tracer.NativeSpan(options) })),
    Layer.succeed(References.MinimumLogLevel, 'Info'),
  ),
);
