import { Effect } from 'effect';
import { runSync } from 'effect/Effect';

declare const inner: Effect.Effect<number>;
declare const Row: (props: Record<string, number>) => unknown;
declare const Panel: { Body: (props: { children?: unknown }) => unknown };

export const program = Effect.gen(function* () {
	return runSync(inner);
});

const identity = <A,>(value: A): A => value;

/** JSX attribute names, member components and fragments are not value references. */
export function View(): unknown {
	return (
		<>
			<Row runSync={1} />
			<Panel.Body>{identity('runSync')}</Panel.Body>
		</>
	);
}
