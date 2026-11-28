import { Layer, Logger, ManagedRuntime, References, Tracer } from 'effect';
import { FetchHttpClient } from 'effect/http';
import { Atom } from 'effect/reactivity';

const financeBrowserLayer = Layer.mergeAll(
  FetchHttpClient.layer,
  Layer.succeed(FetchHttpClient.RequestInit, { cache: 'no-store', credentials: 'include' }),
  Logger.layer([Logger.defaultLogger, Logger.tracerLogger]),
  Layer.succeed(Tracer.Tracer, Tracer.make({ span: (options) => new Tracer.NativeSpan(options) })),
  Layer.succeed(References.MinimumLogLevel, 'Info'),
);

// One owner browser driver owns fibers for every finance read and mutation.
export const financeBrowserRuntime = ManagedRuntime.make(financeBrowserLayer);

/** The same browser services for atoms: the forms React renders from effect-form state. */
export const financeBrowserAtomRuntime = Atom.runtime(financeBrowserLayer);
