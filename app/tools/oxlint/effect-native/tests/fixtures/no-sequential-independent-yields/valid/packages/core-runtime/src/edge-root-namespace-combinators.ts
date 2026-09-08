// FALSE POSITIVE probe (currently reports): with `import * as E from "effect"` the rule recognises
// `E.Effect.gen` as the generator wrapper, but `effectMember` only matches a `MemberExpression`
// whose object is an *Identifier*, so `E.Effect.all(...)` and `E.Effect.sleep(...)` are classified
// as ordinary non-effect reads. The B1 target shape — `yield* E.Effect.all([...], { concurrency })`
// — is therefore reported as the anti-pattern it is the fix for.
// Fix direction: reject a candidate whenever the callee resolves to an `effect` namespace member
// through the same matcher `isGenCallee` already uses (root namespace, computed, optional).
import * as E from "effect";

declare const readOne: E.Effect.Effect<string>;
declare const readTwo: E.Effect.Effect<string>;

export const program = E.Effect.gen(function* () {
	const both = yield* E.Effect.all([readOne, readTwo], { concurrency: 2 });
	const slept = yield* E.Effect.sleep("1 second");
	return { both, slept };
});
