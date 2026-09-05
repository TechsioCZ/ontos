import { Effect } from 'effect';
import { runSync } from 'effect/Effect';

declare const inner: Effect.Effect<number>;

export const program = Effect.gen(function* () {
	return runSync(inner);
});

/** A parameter, a local and a destructuring key that shadow the import are unrelated bindings. */
export const make = (runSync: () => number): number => runSync();

export const local = (): number => {
	const runSync = (): number => 1;
	return runSync();
};

export const destructured = (ports: Record<string, () => number>): number => {
	const { runSync: injected } = ports;
	return injected();
};
