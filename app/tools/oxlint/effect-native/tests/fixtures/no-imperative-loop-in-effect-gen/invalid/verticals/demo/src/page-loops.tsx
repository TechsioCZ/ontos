// expect-count: 3
// Optional chaining on the namespace, `Effect.fnUntraced`, and a `.tsx` module.
import { Effect } from "effect";

declare const rows: readonly string[];
declare const render: (row: string) => Effect.Effect<string>;

export const program = Effect?.gen(function* () {
	const out: string[] = [];
	for (const row of rows) {
		out.push(yield* render(row));
	}
	return out;
});

export const enrich = Effect.fnUntraced(function* (items: readonly string[]) {
	let index = 0;
	while (index < items.length) {
		yield* render(items[index] ?? "");
		index += 1;
	}
	return index;
});

export function Panel(): unknown {
	return <div data-count={rows.length} />;
}
