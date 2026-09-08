import { Cause, Effect, Exit } from 'effect';

class RollbackSignal<E> {
	readonly cause: Cause.Cause<E>;

	constructor(cause: Cause.Cause<E>) {
		this.cause = cause;
	}

	rethrow(): Effect.Effect<never, E> {
		return Effect.failCause(this.cause);
	}
}

export const describe = <A, E>(handlerExit: Exit.Exit<A, E>): Effect.Effect<void> => {
	if (Cause.hasDies(handlerExit.cause) || Cause.hasInterrupts(handlerExit.cause)) {
		return Effect.logError('Unexpected Action execution defect', handlerExit.cause);
	}
	const failure = Cause.findErrorOption(handlerExit.cause);
	return Effect.logWarning('Governed failure', failure);
};

export const rethrow = <E>(signal: RollbackSignal<E>): Effect.Effect<never, E> =>
	Effect.failCause(signal.cause);
