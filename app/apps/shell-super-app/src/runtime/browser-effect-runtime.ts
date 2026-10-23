import { FetchHttpClient } from 'effect/unstable/http';

import { Layer, Logger, ManagedRuntime, References, Tracer } from 'effect';

const browserTracer = Tracer.make({
  span: (options) => new Tracer.NativeSpan(options),
});

export const browserRuntime = ManagedRuntime.make(
  Layer.mergeAll(
    FetchHttpClient.layer,
    Logger.layer([Logger.defaultLogger]),
    Layer.succeed(Tracer.Tracer, browserTracer),
    Layer.succeed(References.MinimumLogLevel, 'Info'),
  ),
);
