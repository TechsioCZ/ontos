// expect-count: 6
import { Cause, Effect, Exit, Option, Schema } from 'effect';

import { ActionTransactionError } from './errors.ts';

export function classify(failure: Option.Option<unknown>, exit: Exit.Exit<number, Error>): string {
	if (failure._tag === 'Some' && Schema.is(ActionTransactionError)(failure.value)) return 'transaction';
	if (failure._tag !== 'None') return 'other';
	if (exit._tag === 'Failure') return Cause.pretty(exit.cause);
	if ('Success' === exit._tag) return 'ok';
	const pending = { checkpointPending: exit._tag === 'Failure' };
	return pending.checkpointPending ? 'pending' : String(Effect.succeed(exit['_tag'] === 'Success'));
}
