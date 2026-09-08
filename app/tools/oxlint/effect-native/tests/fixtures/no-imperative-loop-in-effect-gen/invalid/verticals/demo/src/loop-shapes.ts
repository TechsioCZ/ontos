// expect-count: 5
// Aliased `effect` import, `Effect.fn` / `Effect.fnUntraced` wrappers, computed member access, and
// every loop keyword the rule covers.
import { Effect as E } from "effect";

declare const load: (id: string) => E.Effect<string>;
declare const fetchRemaining: () => E.Effect<number>;
declare const handle: (key: string) => E.Effect<void>;
declare const more: () => E.Effect<boolean>;
declare const step: () => E.Effect<void>;
declare const registry: Record<string, string>;

// classic `for` — the loop index lives in the loop head, so it is not a reported accumulator.
export const loadAll = E.fn("loadAll")(function* (ids: readonly string[]) {
	for (let index = 0; index < ids.length; index += 1) {
		yield* load(ids[index] ?? "");
	}
});

// `do...while` plus one outer accumulator.
export const drain = E.fnUntraced(function* () {
	let remaining = 1;
	do {
		remaining = yield* fetchRemaining();
	} while (remaining > 0);
	return remaining;
});

// `for...in`
export const eachKey = E.gen(function* () {
	for (const key in registry) {
		yield* handle(key);
	}
});

// computed namespace access and a `yield*` in the loop test position.
export const untilDone = E["gen"](function* () {
	while (yield* more()) {
		yield* step();
	}
});
