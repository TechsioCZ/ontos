import * as Exit from 'effect/Exit';
import { Effect, Cause as EffectCause } from 'effect';

const boot = async (): Promise<void> => {};
await boot();

export const report = <A, E>(migrationExit: Exit.Exit<A, E>): Effect.Effect<void> =>
	Exit.isFailure(migrationExit)
		? Effect.logError('defect', EffectCause.pretty(migrationExit.cause))
		: Effect.void;
