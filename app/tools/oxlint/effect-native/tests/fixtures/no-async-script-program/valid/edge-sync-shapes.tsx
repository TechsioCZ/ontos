import { Effect } from "effect";

declare const values: readonly string[];

// Sync generators, sync class members, JSX and non-await for-of are untouched.
export function* enumerate(): Generator<string> {
	for (const value of values) yield value;
}

class Sync {
	static build(): Sync {
		return new Sync();
	}
	*iterate(): Generator<number> {
		yield 1;
	}
	handler = (): void => {};
	accessor loader = (): number => 1;
}

export const Panel = ({ label }: { readonly label: string }): JSX.Element => (
	<button onClick={() => console.log(label)} type="button">
		{label}
	</button>
);

export const program = Effect.gen(function* () {
	yield* Effect.forEach(values, (value) => Effect.log(value));
});

void Sync;
