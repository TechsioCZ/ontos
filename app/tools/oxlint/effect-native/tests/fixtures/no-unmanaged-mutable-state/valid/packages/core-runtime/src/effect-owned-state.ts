// The target shapes: Ref/SynchronizedRef, Effect.cached, Context.Reference and Layer.scoped own
// the lifetime, and the defect cause travels on the error contract instead of in a WeakMap.
import { Context, Effect, Layer, Ref, Schema } from "effect";

export class ActionTransactionError extends Schema.TaggedError<ActionTransactionError>()(
	"ActionTransactionError",
	{ cause: Schema.optional(Schema.Defect), reason: Schema.String },
) {}

export class CorrelationId extends Context.Reference<CorrelationId>()("CorrelationId", {
	defaultValue: () => "anonymous",
}) {}

export const counterProgram = Effect.gen(function* () {
	const counter = yield* Ref.make(0);
	yield* Ref.update(counter, (value) => value + 1);
	return yield* Ref.get(counter);
});

export class QueryClientOwner extends Context.Tag("QueryClientOwner")<
	QueryClientOwner,
	{ readonly id: string }
>() {}

export const QueryClientOwnerLive = Layer.scoped(
	QueryClientOwner,
	Effect.acquireRelease(Effect.succeed({ id: "browser" }), () => Effect.void),
);
