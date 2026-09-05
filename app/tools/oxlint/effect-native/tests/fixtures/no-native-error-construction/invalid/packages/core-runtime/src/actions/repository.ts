// expect-count: 6
// Mirrors packages/core-runtime/src/actions/repository.ts:98 and :360 — a hand-rolled error class,
// V8 stack surgery, cyclic-payload TypeErrors and an uncertain-commit invariant (audit A4/A5).
import { Effect } from "effect";

export class ActionRepositoryError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "ActionRepositoryError";
		Error.captureStackTrace(this, ActionRepositoryError);
	}
}

const canonicalise = (value: unknown, seen: WeakSet<object>): unknown => {
	if (typeof value === "object" && value !== null) {
		if (seen.has(value)) throw new TypeError("Action payloads must not contain cyclic values");
		seen.add(value);
	}
	return value;
};

export const insertInvocation = (payload: unknown) =>
	Effect.tryPromise({
		try: async () => canonicalise(payload, new WeakSet()),
		// Local error classes are not the global constructor and are not reported here.
		catch: (cause) =>
			cause instanceof ActionRepositoryError ? cause : new ActionRepositoryError(String(cause)),
	});

export const resolveConflict = (row: unknown): unknown => {
	if (row === undefined) {
		throw new Error("A non-idempotent invocation insert unexpectedly conflicted");
	}
	return row;
};

export const describeFlushFailure = (causes: readonly unknown[]) =>
	new AggregateError([...causes], "outbox flush failed");

export const describeCause = (cause: unknown): string =>
	cause instanceof Error ? cause.message : String(cause);
