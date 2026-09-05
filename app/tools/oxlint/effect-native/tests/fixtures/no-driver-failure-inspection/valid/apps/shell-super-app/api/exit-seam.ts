import { Cause as C, Effect, Exit as Ex } from 'effect';

export const toProblem = <A, E>(scopeExit: Ex.Exit<A, E>): Effect.Effect<void> =>
	Ex.isFailure(scopeExit) ? Effect.logError('defect', C.pretty(scopeExit.cause)) : Effect.void;

export const rethrow = <E>(bridgeFailure: { readonly cause: C.Cause<E> }): Effect.Effect<never, E> =>
	Effect.failCause(bridgeFailure.cause);
