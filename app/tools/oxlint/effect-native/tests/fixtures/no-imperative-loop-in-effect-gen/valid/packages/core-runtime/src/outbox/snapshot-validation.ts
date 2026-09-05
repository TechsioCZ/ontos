// FALSE POSITIVE regression fixture — reduced from
// `packages/core-runtime/src/outbox/runtime.ts:211`
// (`validateDeployedRegistrationSnapshot`), reported by the rule today.
//
// The loop body sequences NO Effect. It evaluates a pure predicate; the only
// delegating `yield*` is in terminal position (`return yield* fail(...)`), so at
// most ONE effect ever runs and it ends the program. There is nothing to make
// concurrent, no `Schedule` to carry, and no fold to hoist — the declarative
// rewrite is `registrations.some(...)` plus a single failure, i.e. exactly the
// D-tier "native array/object operations where Effect collection APIs add no
// semantic value" that the audit blesses. `Effect.forEach` here would be worse.
//
// Suggested fix: skip a loop when every delegating `yield*` it contains sits in
// terminal position (argument of `return` / `throw`) relative to the loop body.
import { Effect } from "effect";

declare const registrations: readonly { readonly workerKey: string }[];
declare const matches: (registration: { readonly workerKey: string }) => boolean;
declare const descriptorFailure: (reason: string) => Effect.Effect<never, Error>;

export const validateSnapshot = Effect.gen(function* validateSnapshotEffect() {
	for (const registration of registrations) {
		if (!matches(registration)) {
			return yield* descriptorFailure(`worker ${registration.workerKey} is absent`);
		}
	}
});
