import { Effect } from 'effect';

declare const poll: Effect.Effect<void>;

/** Node process entrypoint: one root fiber for the whole worker. */
export const main = (): void => {
	Effect.runFork(poll);
};
