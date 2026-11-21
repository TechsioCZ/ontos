import { Layer, Logger, ManagedRuntime, References, Tracer } from 'effect';

const browserTracer = Tracer.make({ span: (options) => new Tracer.NativeSpan(options) });

/** The one browser runtime of this vertical's staff pages: their page data loads run on it. */
export const browserRuntime = ManagedRuntime.make(
  Layer.mergeAll(
    Logger.layer([Logger.defaultLogger]),
    Layer.succeed(Tracer.Tracer, browserTracer),
    Layer.succeed(References.MinimumLogLevel, 'Info'),
  ),
);
