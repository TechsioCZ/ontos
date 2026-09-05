// expect-count: 8
// Adversarial: modern TS/JS syntax around the callback — two-argument `gen`, async generators,
// spread option bags, optional computed calls, template IIFEs, default parameters, decorators.
import { Effect as Fx } from 'effect';

declare const base: { readonly catch: (error: unknown) => unknown };

// 1 — `Effect.gen(this, function* () {…})`.
class Service {
  run = Fx.gen(this, function* () {
    throw new Error('two-argument gen');
  });
}
export const service = new Service();

// 2 — async generator body.
export const asyncGen = Fx.gen(async function* () {
  throw new Error('async generator');
});

// 3 — spread-built `{ try, catch }` bag.
export const spreadBag = Fx.tryPromise({ ...base, try: async () => { throw new Error('spread bag'); } });

// 4 — optional call on a computed member.
export const optionalComputed = Fx?.['sync']?.(() => { throw new Error('optional computed'); });

// 5 — IIFE inside a template literal inside the callback.
export const template = Fx.sync(() => `${(() => { throw new Error('template iife'); })()}`);

// 6 — combinator call used as a default parameter value.
export function withDefault(cb = Fx.sync(() => { throw new Error('default parameter'); })): unknown {
  return cb;
}

// 7 — decorated method of a class declared inside an Effect callback.
export const decorated = Fx.sync(() => {
  function log(): MethodDecorator {
    return () => undefined;
  }
  class Inner {
    @log() run(): void {
      throw new Error('decorated method inside a callback');
    }
  }
  return new Inner();
});

// 8 — `Effect.fnUntraced` applied directly (the non-curried A6 shape).
export const untraced = Fx.fnUntraced(function* () {
  throw new Error('fnUntraced body');
});
