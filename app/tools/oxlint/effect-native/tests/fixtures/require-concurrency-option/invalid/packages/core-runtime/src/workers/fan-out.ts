// expect-count: 12
import { Effect as Fx, Stream as Sx, pipe } from 'effect';

declare const items: readonly string[];
declare const run: (value: string) => Fx.Effect<number>;
declare const combine: (left: number, right: number) => Fx.Effect<number>;
declare const zero: Fx.Effect<number>;
declare const left: Fx.Effect<number>;
declare const right: Fx.Effect<number>;
declare const source: Sx.Stream<string>;

// Aliased namespace, plain data-first: no options argument at all.
export const each = Fx.forEach(items, run);

// Computed member access must not escape the rule.
export const both = Fx['all']([left, right]);

// Optional chaining must not escape the rule.
export const split = Fx?.partition(items, run);

// An options object that carries no `concurrency` key is still sequential.
export const discarded = Fx.all([left, right], { discard: true });

// Explicit unbounded fan-out over the pool is a load-shedding hazard, not a policy.
export const flooded = Fx.all([left, right], { concurrency: 'unbounded' });

// `inherit` resolves to the ambient (unbounded by default) fiber concurrency.
export const inherited = Fx.validateAll(items, run, { concurrency: 'inherit' });

// Stream fan-out defaults to sequential in exactly the same way.
export const mapped = Sx.mapEffect(source, run);

// Data-last through `pipe`: the options slot shifts left by one.
export const piped = pipe(source, Sx.flatMap(run));

// `reduceEffect` takes its options in the fourth slot.
export const reduced = Fx.reduceEffect([left, right], zero, combine);

// Data-last through `subject.pipe(operator)`: the options slot shifts the same way.
export const viaMemberPipe = source.pipe(Sx.mapEffect(run));

// `allWith` is data-last by construction; an options object without `concurrency` is still sequential.
export const withoutBound = Fx.allWith({ discard: true });

// `allSuccesses` fans out too.
export const successes = Fx.allSuccesses([left, right]);
