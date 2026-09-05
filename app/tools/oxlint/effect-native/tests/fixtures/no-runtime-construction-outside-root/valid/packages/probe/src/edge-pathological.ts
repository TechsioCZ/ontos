#!/usr/bin/env node
// Shebang, deep optional chains, `super`/`new.target`/`import.meta` objects, private members and a
// namespace-shaped property that is not the effect import. None of these construct a runtime.
import { Effect, Layer, ManagedRuntime } from 'effect';

declare const registry: { readonly nested?: { readonly Layer?: { readonly launch: (a: unknown) => unknown } } };
declare const appLayer: Layer.Layer<never>;

export const deepChain = registry?.nested?.Layer?.launch?.(appLayer);
export const meta = import.meta.url;

class Base {
  make(value: unknown): unknown {
    return value;
  }
}

export class Child extends Base {
  #ManagedRuntime = { make: (a: unknown): unknown => a };

  override make(value: unknown): unknown {
    void new.target;
    void this.#ManagedRuntime.make(value);
    return super.make(value);
  }
}

export const stillEffect = Effect.gen(function* () {
  return yield* Effect.succeed(ManagedRuntime.isManagedRuntime(appLayer));
});
