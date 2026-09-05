// `.mts` crash probe: compliant root, async generators, template literals, private class fields.
import { Layer, Logger, ManagedRuntime, References, Tracer } from 'effect';

declare const workerLayer: Layer.Layer<never>;
declare const tracer: Tracer.Tracer;

const observability = Layer.mergeAll(
  Logger.layer([Logger.consoleJson]),
  Layer.succeed(Tracer.Tracer, tracer),
  Layer.succeed(References.MinimumLogLevel, 'Info'),
);

export const runtime = ManagedRuntime.make(Layer.provide(workerLayer, observability));

export class Counter {
  #count = 0;

  async *tick(): AsyncGenerator<string> {
    yield `${(this.#count += 1)}`;
  }
}
