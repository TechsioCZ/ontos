// Regression fixture for a false positive: `runSeam` matches `<name>.run*` purely from the
// module-level import table, without the `getScope` check the runner branch already performs.
// A local binding that shadows the `effect` namespace is not the Effect namespace, and none of
// these calls starts a root fiber.
import { Effect } from 'effect';

export const program = Effect.succeed(1);

export interface RunnerPort {
	readonly runPromise: (value: number) => Promise<number>;
	readonly runSync: (value: number) => number;
}

// Parameter shadows the import: `Effect` here is the caller's port, not `effect`.
export const describePort = (Effect: RunnerPort) => Effect.runPromise(1);

export const nestedShadow = (port: RunnerPort) => {
	const Effect = port;
	return Effect.runSync(1);
};
