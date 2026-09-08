// FALSE POSITIVE probe (currently reports): the rule accepts a computed callee as a candidate
// (`memberName` reads `["all"]`) but `effectMember` refuses computed members, so the `effect`
// exclusion never fires and two adjacent `Fx["all"]` fan-outs are reported as sequential reads.
// Same root cause as `edge-root-namespace-combinators.ts`: candidate *acceptance* is more permissive
// than candidate *rejection*.
import { Effect as Fx } from "effect";

declare const readOne: Fx.Effect<string>;
declare const readTwo: Fx.Effect<string>;

export const program = Fx.gen(function* () {
	const first = yield* Fx["all"]([readOne, readTwo], { concurrency: 2 });
	const second = yield* Fx["all"]([readTwo, readOne], { concurrency: 2 });
	return { first, second };
});
