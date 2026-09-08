import { Effect, Stream } from 'effect';

declare const load: (id: string) => Effect.Effect<string>;
declare const source: Stream.Stream<string>;

// Point-free data-last `forEach(f, options)`: the bound is spelled out right there in the source.
export const boundedStep = Effect.forEach(load, { concurrency: 4 });

// The same bounded operator handed straight to another combinator.
export const staged = Effect.flatMap(Effect.forEach(load, { concurrency: 4 }));

// Stream data-last with a named effectful function and an explicit bound.
export const streamStep = Stream.mapEffect(load, { concurrency: 3 });

// A deliberately sequential data-last operator, stored for reuse — exactly what B1 asks for.
export const sequentialStep = Effect.forEach(load, { concurrency: 1 });

export const unused = source;
