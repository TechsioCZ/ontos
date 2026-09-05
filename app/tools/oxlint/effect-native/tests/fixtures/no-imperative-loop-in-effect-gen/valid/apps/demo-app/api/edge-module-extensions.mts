// `.mts` entrypoint: the outer process seam plus a look-alike wrapper, neither of which is
// `Effect.gen`.
import { Effect } from "effect";

declare const tasks: ReadonlyArray<Effect.Effect<void>>;
declare const actions: readonly string[];
declare const step: (action: string) => Generator<unknown, void>;

const saga = { gen: (body: unknown) => body };

export const watcher = saga.gen(function* () {
	for (const action of actions) {
		yield* step(action);
	}
});

export const main = async (): Promise<void> => {
	for (const task of tasks) {
		await Effect.runPromise(task);
	}
};
