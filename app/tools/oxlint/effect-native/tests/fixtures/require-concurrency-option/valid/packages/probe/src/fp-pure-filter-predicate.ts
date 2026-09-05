import { Effect, Filter, pipe } from 'effect';

declare const items: readonly { readonly enabled: boolean; readonly id: string }[];
declare const keep: Filter.Filter<{ readonly id: string }, string>;

/**
 * False positive: the *pure* overloads of `Effect.filter` / `Effect.filterMap` take no options
 * argument at all (effect@4.0.0-beta.107 `dist/Effect.d.ts`:
 * `<A>(elements: Iterable<A>, predicate: Predicate.Predicate<A>): Effect<Array<A>>` and
 * `<A, B, X>(elements: Iterable<A>, filter: Filter.Filter<...>): Effect<Array<B>>`).
 * Only the `Effect<boolean, E, R>` / `FilterEffect` overloads accept `{ concurrency }`.
 *
 * These three calls run a synchronous predicate over an in-memory array: there is nothing to fan
 * out, and the reported fix is not even expressible — adding `{ concurrency: 1 }` selects no
 * overload and is a type error. This is the risk the rule spec listed as
 * "filter/filterMap with pure predicates".
 */
export const enabled = Effect.filter(items, (item) => item.enabled);

export const kept = Effect.filterMap(items, keep);

export const enabledPiped = pipe(
	items,
	Effect.filter((item) => item.enabled),
);
