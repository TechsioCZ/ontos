import { Layer, Logger, ManagedRuntime, References, Tracer } from 'effect';

const browserTracer = Tracer.make({ span: (options) => new Tracer.NativeSpan(options) });

/** The one browser runtime of this vertical's pages: page data loads, Actions and polling run on it. */
export const browserRuntime = ManagedRuntime.make(
  Layer.mergeAll(
    Logger.layer([Logger.defaultLogger]),
    Layer.succeed(Tracer.Tracer, browserTracer),
    Layer.succeed(References.MinimumLogLevel, 'Info'),
  ),
);
