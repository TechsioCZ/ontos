import { Layer, Logger, ManagedRuntime, References, Tracer } from 'effect';
import { FetchHttpClient } from 'effect/http';
import { Atom } from 'effect/reactivity';

const browserTracer = Tracer.make({ span: (options) => new Tracer.NativeSpan(options) });
const browserLayer = Layer.mergeAll(
  Logger.layer([Logger.defaultLogger]),
  Layer.succeed(Tracer.Tracer, browserTracer),
  Layer.succeed(References.MinimumLogLevel, 'Info'),
  FetchHttpClient.layer,
);

export const browserRuntime = ManagedRuntime.make(browserLayer);

/** The same browser services for atoms: the forms and reads that React renders from atom state. */
export const browserAtomRuntime = Atom.runtime(browserLayer);
