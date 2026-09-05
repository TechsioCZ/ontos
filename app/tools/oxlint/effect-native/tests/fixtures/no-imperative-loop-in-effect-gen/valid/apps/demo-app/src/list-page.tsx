// React rendering: a `for...of` that builds JSX children, plus the declarative Effect target.
import { Effect } from "effect";

declare const rows: readonly string[];
declare const render: (row: string) => Effect.Effect<string>;

export const rendered = Effect.gen(function* () {
	return yield* Effect.forEach(rows, render, { concurrency: "unbounded" });
});

export function List(): unknown {
	const children: unknown[] = [];
	for (const row of rows) {
		children.push(<li key={row}>{row}</li>);
	}
	return <ul>{children}</ul>;
}
