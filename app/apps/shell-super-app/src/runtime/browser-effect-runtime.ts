import { Layer, Logger, ManagedRuntime, References, Tracer } from 'effect';

const browserTracer = Tracer.make({
  span: (options) => new Tracer.NativeSpan(options),
});

const browserRuntime = ManagedRuntime.make(
  Layer.mergeAll(
    Logger.layer([Logger.defaultLogger]),
    Layer.succeed(Tracer.Tracer, browserTracer),
    Layer.succeed(References.MinimumLogLevel, 'Info'),
  ),
);

export const runBrowserEffect = browserRuntime.runPromise;
