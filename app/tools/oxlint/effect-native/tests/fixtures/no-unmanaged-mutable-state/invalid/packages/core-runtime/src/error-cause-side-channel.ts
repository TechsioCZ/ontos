// expect-count: 4
// A4: the cause of a typed error is stashed in a module-level WeakMap keyed by the error instance.
import { Schema } from "effect";

export class OutboxPersistenceError extends Schema.TaggedError<OutboxPersistenceError>()(
	"OutboxPersistenceError",
	{ reason: Schema.String },
) {}

const persistenceCauses = new WeakMap<OutboxPersistenceError, unknown>();
const transactionFailureCauses = new globalThis.WeakMap<OutboxPersistenceError, unknown>();
const trustedContexts = new WeakSet<object>();

export const attachCause = (error: OutboxPersistenceError, cause: unknown): void => {
	persistenceCauses.set(error, cause);
	transactionFailureCauses.set(error, cause);
};

export const readCause = (error: OutboxPersistenceError): unknown => persistenceCauses.get(error);

export const trust = (context: object): void => {
	trustedContexts.add(context);
};

export const isTrusted = (context: object): boolean => trustedContexts.has(context);

const makeSeen = () => new WeakSet<object>();

export const freshSeen = makeSeen;
