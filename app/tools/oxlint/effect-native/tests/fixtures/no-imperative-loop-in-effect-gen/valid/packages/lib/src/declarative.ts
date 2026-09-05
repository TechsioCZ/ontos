// The B1 target shapes: bounded fan-out, declarative folds, iterate/loop, Schedule-driven polling
// and Stream pagination. None of these contain a loop keyword at all.
import { Duration, Effect, Schedule, Stream } from "effect";

declare const actions: readonly string[];
declare const items: readonly number[];
declare const provisioning: { readonly ensure: (action: string) => Effect.Effect<void> };
declare const readA: Effect.Effect<string>;
declare const readB: Effect.Effect<string>;
declare const claimNext: (owner: string) => Effect.Effect<string | null>;
declare const page: (cursor: number) => Effect.Effect<readonly [readonly string[], number | null]>;
declare const tick: Effect.Effect<void>;

export const bounded = Effect.gen(function* () {
	const outcomes = yield* Effect.forEach(actions, provisioning.ensure, { concurrency: 4 });
	const both = yield* Effect.all([readA, readB], { concurrency: "unbounded" });
	const total = yield* Effect.reduce(items, 0, (accumulator, item) => Effect.succeed(accumulator + item));
	return { both, outcomes, total };
});

export const drain = Effect.gen(function* () {
	const claimed = yield* Effect.iterate(0, {
		body: (count) => Effect.map(claimNext("worker"), (claim) => (claim === null ? count : count + 1)),
		while: (count) => count < 100,
	});
	return claimed;
});

export const poller = Effect.repeat(tick, Schedule.spaced(Duration.seconds(5)));

export const paginated = Stream.paginateEffect(0, (cursor) => page(cursor)).pipe(
	Stream.runFold(0, (count) => count + 1),
);
