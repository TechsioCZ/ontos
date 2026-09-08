#!/usr/bin/env node
// Pathological syntax that must parse without crashing and must not report: decorators, class static
// blocks, private fields, `accessor`, `using`, and throws outside every Effect combinator callback.
import { Effect } from 'effect';

function decorate(fn: () => void): ClassDecorator {
  void fn;
  return () => undefined;
}

@decorate(() => {
  throw new Error('decorator argument is not an Effect callback');
})
class Holder {
  static #count = 0;
  accessor label: string = 'shell';
  #secret = 1;
  static {
    if (Holder.#count < 0) {
      throw new Error('static block outside every Effect callback');
    }
  }
  read(): number {
    return this.#secret;
  }
}

export function bootstrap(): Holder {
  using _guard = { [Symbol.dispose]: () => undefined };
  void _guard;
  if (Holder === undefined) {
    throw new Error('the single outer process adapter seam may throw');
  }
  return new Holder();
}

export const program = Effect.sync(() => 1);
