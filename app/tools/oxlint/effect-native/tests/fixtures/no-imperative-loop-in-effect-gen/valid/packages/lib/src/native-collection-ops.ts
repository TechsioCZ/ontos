// D tier: "Native array/object operations where Effect collection APIs add no semantic value."
// These loops sequence nothing — no `yield*` appears in any of them.
import { Effect } from "effect";

declare const repository: { readonly load: () => Effect.Effect<ReadonlyArray<{ readonly count: number }>> };
declare const registry: Record<string, number>;

export const summarise = Effect.gen(function* () {
	const rows = yield* repository.load();

	let total = 0;
	for (const row of rows) {
		total += row.count;
	}

	for (let index = 0; index < rows.length; index += 1) {
		total += index;
	}

	for (const key in registry) {
		total += registry[key] ?? 0;
	}

	while (total > 1_000) {
		total -= 10;
	}

	do {
		total += 1;
	} while (total % 7 !== 0);

	return total;
});

// A nested generator owns its own `yield*`: the outer `for...of` only builds effects.
export const buildPrograms = Effect.gen(function* () {
	const rows = yield* repository.load();
	const programs: Array<Effect.Effect<number>> = [];
	for (const row of rows) {
		programs.push(
			Effect.gen(function* () {
				const loaded = yield* repository.load();
				return loaded.length + row.count;
			}),
		);
	}
	return yield* Effect.all(programs, { concurrency: 8 });
});
