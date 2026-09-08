// expect-count: 2
import { Effect } from 'effect';

declare const resolver: { resolveDefaultBetterAuthUser: (id: string) => Effect.Effect<string> };

/** Forced better-auth Promise hook that starts a fresh root fiber instead of using the host runtime. */
export const resolveForSession = async (id: string): Promise<string> =>
	await Effect.runPromise(resolver.resolveDefaultBetterAuthUser(id)).catch(() => {
		throw new Error('FORBIDDEN');
	});

export const hooks = {
	after: (id: string): void => {
		Effect.runFork(resolver.resolveDefaultBetterAuthUser(id));
	},
};
