import { Effect, Match, Schema } from 'effect';
import { decodeDatabaseFailure } from '../db/failure-decoder.ts';
import type { DatabaseFailure } from '../db/failure-decoder.ts';

class ContactsCustomerIcoConflict extends Schema.TaggedError<ContactsCustomerIcoConflict>()(
	'ContactsCustomerIcoConflict',
	{ reason: Schema.String },
) {}

export const insertCustomer = (run: () => Promise<void>) =>
	Effect.tryPromise({ catch: decodeDatabaseFailure, try: run }).pipe(
		Effect.catchTag('DatabaseUniqueViolation', (failure) =>
			Effect.fail(new ContactsCustomerIcoConflict({ cause: failure, reason: 'ico_taken' })),
		),
	);

export const retryable = (failure: DatabaseFailure): boolean =>
	Match.value(failure).pipe(
		Match.tags({
			DatabaseDeadlock: () => true,
			DatabaseSerializationFailure: () => true,
			DatabaseUnavailable: () => true,
			DatabaseUniqueViolation: () => false,
		}),
		Match.orElse(() => false),
	);
