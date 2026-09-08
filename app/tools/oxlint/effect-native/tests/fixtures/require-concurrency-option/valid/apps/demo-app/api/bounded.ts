import { Effect, Stream, pipe } from 'effect';
import { Effect as EdgeEffect } from '@modern-js/plugin-bff/effect-edge';

declare const providers: readonly string[];
declare const search: (provider: string) => Effect.Effect<string>;
declare const left: Effect.Effect<number>;
declare const right: Effect.Effect<number>;
declare const only: Effect.Effect<number>;
declare const solo: Effect.Effect<number>;
declare const zero: Effect.Effect<number>;
declare const combine: (a: number, b: number) => Effect.Effect<number>;
declare const baseOptions: { readonly concurrency: number };
declare const source: Stream.Stream<string>;
declare const run: (value: string) => Effect.Effect<number>;

// The target shape: an explicit bound sized for the downstream resource.
export const bounded = Effect.forEach(providers, search, { concurrency: 8 });

// A spread may carry `concurrency`; without types the rule must not guess (strictSpread: false).
export const spread = Effect.all([left, right], { ...baseOptions });

// Deterministic ordering is a real business requirement — spelled out, not accidental.
export const ordered = Effect.all([left, right], { concurrency: 1 });

// A non-literal options bag is equally uninspectable.
export const shared = Effect.all([left, right], baseOptions);

// A one-element literal collection is not a fan-out.
export const single = Effect.all([only]);
export const singleStruct = Effect.all({ solo });
export const singleForEach = Effect.forEach([only], (effect) => effect);

// Data-last with an explicit bound.
export const curried = Effect.forEach((provider: string) => search(provider), { concurrency: 4 })(
  providers,
);

// `allWith` is data-last by construction: its only argument is the options object.
export const allWith = Effect.allWith({ concurrency: 2 });

// Bounded Stream fan-out, data-first and through `pipe`.
export const streamed = Stream.mapEffect(source, run, { concurrency: 3 });
export const pipedStream = pipe(source, Stream.flatMap(run, { concurrency: 2 }));

// `reduceEffect` options live in the fourth slot.
export const reduced = Effect.reduceEffect([left, right], zero, combine, { concurrency: 2 });

// Non-fan-out combinators are never matched.
export const mappedOnce = left.pipe(Effect.map((value) => value + 1));
export const chained = left.pipe(Effect.flatMap((value) => combine(value, 1)));
export const caught = left.pipe(Effect.catch(() => right));

// The re-export barrel is treated exactly like `effect`, including its bounded form.
export const boundedEdge = EdgeEffect.forEach(providers, search, { concurrency: 6 });
