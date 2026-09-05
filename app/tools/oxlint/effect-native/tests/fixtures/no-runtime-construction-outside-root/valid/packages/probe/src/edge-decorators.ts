// Decorators, accessors, private fields and static blocks around effect code that never constructs.
import { Effect, Layer, ManagedRuntime } from 'effect';

declare function log(): PropertyDecorator;
declare const appLayer: Layer.Layer<never>;

export class Wiring {
  static #registry = new Map<string, unknown>();
  #make = (value: unknown): unknown => value;

  @log()
  accessor launch: string = 'never';

  static {
    Wiring.#registry.set('layer', Layer.provide(appLayer, appLayer));
  }

  make(value: unknown): unknown {
    return this.#make(value);
  }

  program(): Effect.Effect<number> {
    return Effect.gen(function* () {
      return yield* Effect.succeed(ManagedRuntime.isManagedRuntime(appLayer) ? 1 : 0);
    });
  }
}
