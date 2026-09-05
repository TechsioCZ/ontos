import { Effect, Schema } from 'effect';

export class ActionTransactionError extends Schema.TaggedError<ActionTransactionError>()(
	'ActionTransactionError',
	{ reason: Schema.String },
) {}

type Outcome = { readonly _tag: 'Approved' } | { readonly _tag: 'Denied' };

/** Domain tags are the `catchTag`/`Match` concern of audit A4, not this rule. */
export const handle = (error: ActionTransactionError, outcome: Outcome) =>
	Effect.sync(() => {
		if (error._tag === 'ActionTransactionError') return 'transaction';
		if (outcome._tag === 'Approved') return 'approved';
		switch (outcome._tag) {
			case 'Denied':
				return 'denied';
			default:
				return 'unknown';
		}
	});
