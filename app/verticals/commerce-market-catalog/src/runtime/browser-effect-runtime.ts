import { Layer, Logger, ManagedRuntime, References, Tracer } from 'effect';
import { Atom } from 'effect/reactivity';

const browserTracer = Tracer.make({ span: (options) => new Tracer.NativeSpan(options) });

const browserLayer = Layer.mergeAll(
  Logger.layer([Logger.defaultLogger]),
  Layer.succeed(Tracer.Tracer, browserTracer),
  Layer.succeed(References.MinimumLogLevel, 'Info'),
);

/** The one browser runtime of this vertical's pages: page data loads, Actions and polling run on it. */
export const browserRuntime = ManagedRuntime.make(browserLayer);

/** The same browser services for atoms: the forms React renders from atom state. */
export const browserAtomRuntime = Atom.runtime(browserLayer);
