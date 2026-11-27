import { Layer, Logger, References, Tracer } from 'effect';
import { Atom } from 'effect/reactivity';

const browserTracer = Tracer.make({
  span: (options) => new Tracer.NativeSpan(options),
});

/** The browser services for atoms: the forms and reads that React renders from atom state. */
export const browserAtomRuntime = Atom.runtime(
  Layer.mergeAll(
    Logger.layer([Logger.defaultLogger]),
    Layer.succeed(Tracer.Tracer, browserTracer),
    Layer.succeed(References.MinimumLogLevel, 'Info'),
  ),
);
