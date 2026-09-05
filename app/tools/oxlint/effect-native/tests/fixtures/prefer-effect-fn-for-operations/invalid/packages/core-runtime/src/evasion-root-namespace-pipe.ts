// expect-count: 1
import * as Root from "effect";

/** `import * as Root from "effect"` exposes the data-first `Root.pipe(program, …)`. */
export const restore = (id: string) =>
	Root.pipe(
		Root.Effect.gen(function* () {
			yield* Root.Effect.log(id);
		}),
		Root.Effect.withSpan("ContactOps.restore"),
	);
