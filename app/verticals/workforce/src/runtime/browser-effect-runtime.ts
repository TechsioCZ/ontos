import { Layer, Logger, ManagedRuntime, References, Tracer } from 'effect';
import { FetchHttpClient } from 'effect/unstable/http';

const browserTracer = Tracer.make({ span: (options) => new Tracer.NativeSpan(options) });
export const browserRuntime = ManagedRuntime.make(
  Layer.mergeAll(
    Logger.layer([Logger.defaultLogger]),
    Layer.succeed(Tracer.Tracer, browserTracer),
    Layer.succeed(References.MinimumLogLevel, 'Info'),
    // Same-origin fetch for the shell's people administration endpoints (`api/people-admin-client.ts`).
    FetchHttpClient.layer,
  ),
);
