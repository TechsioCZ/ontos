import { Layer, Logger, ManagedRuntime, References, Tracer } from 'effect';

// One owner browser driver owns fibers for every finance read and mutation.
export const financeBrowserRuntime = ManagedRuntime.make(
  Layer.mergeAll(
    Logger.layer([Logger.defaultLogger, Logger.tracerLogger]),
    Layer.succeed(Tracer.Tracer, Tracer.make({ span: (options) => new Tracer.NativeSpan(options) })),
    Layer.succeed(References.MinimumLogLevel, 'Info'),
  ),
);
