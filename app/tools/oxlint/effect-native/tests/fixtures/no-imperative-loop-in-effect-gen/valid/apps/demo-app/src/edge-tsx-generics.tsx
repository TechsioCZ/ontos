// `.tsx` generic-arrow ambiguity plus JSX-building loops that sequence no Effect.
import { Effect } from "effect";

declare const rows: readonly string[];
declare const render: (row: string) => Effect.Effect<string>;

const identity = <T,>(value: T): T => value;

export const program = Effect.gen(function* () {
	return yield* Effect.forEach(identity(rows), render, { concurrency: "unbounded" });
});

export function Table(): unknown {
	const cells: unknown[] = [];
	for (const row of identity(rows)) {
		cells.push(<td key={row}>{row}</td>);
	}
	return <tr>{cells}</tr>;
}
