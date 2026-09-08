// expect-count: 1
import { Effect, Function } from "effect";

/**
 * Data-first `Function.pipe(program, …)`. The rule header claims this form is peeled
 * ("`pipe(Effect.gen(...), …)` / `Function.pipe(…)` (descending `arguments[0]`)"), so the returned
 * program is still a bare `Effect.gen` and must report exactly like the `pipe(…)` fixture.
 */
export const archive = (id: string) =>
	Function.pipe(
		Effect.gen(function* () {
			yield* Effect.log(id);
		}),
		Effect.withSpan("ContactOps.archive"),
	);
