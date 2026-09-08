// Aliased imports must not turn a compliant root into a violation.
import { Layer as L, Logger as Log, ManagedRuntime as MR, References as Refs, Tracer as Tr } from 'effect';

declare const workerLayer: L.Layer<never>;
declare const tracer: Tr.Tracer;

const observability = L.mergeAll(
  Log.layer([Log.consoleJson]),
  L.succeed(Tr.Tracer, tracer),
  L.succeed(Refs.MinimumLogLevel, 'Debug'),
);

export const runtime = MR.make(L.provide(workerLayer, observability));
