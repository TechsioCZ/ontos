import { Effect } from "effect";

interface Props {
	readonly title: string;
}

export const Banner = ({ title }: Props): JSX.Element => <h1>{title}</h1>;

// Plain synchronous helpers and generators are untouched by this rule.
export function* enumerate(values: readonly string[]): Generator<readonly [number, string]> {
	for (const [index, value] of values.entries()) yield [index, value] as const;
}

export const program = Effect.gen(function* () {
	yield* Effect.log("no async here");
	return Effect.succeed(1);
});

for (const value of ["a", "b"]) {
	console.log(value);
}
