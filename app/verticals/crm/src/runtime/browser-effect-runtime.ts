import { Layer, Logger, ManagedRuntime, References, Tracer } from 'effect';
import { Atom } from 'effect/reactivity';
import { FetchHttpClient } from 'effect/http';

const browserTracer = Tracer.make({ span: (options) => new Tracer.NativeSpan(options) });
const browserLayer = Layer.mergeAll(
  Logger.layer([Logger.defaultLogger]),
  Layer.succeed(Tracer.Tracer, browserTracer),
  Layer.succeed(References.MinimumLogLevel, 'Info'),
  // Same-origin fetch for the shell's account list (Obchodníci panel, klienti/team-panel.tsx).
  FetchHttpClient.layer,
);

export const browserRuntime = ManagedRuntime.make(browserLayer);

/** The same browser services for atoms: the forms and reads that React renders from atom state. */
export const browserAtomRuntime = Atom.runtime(browserLayer);
