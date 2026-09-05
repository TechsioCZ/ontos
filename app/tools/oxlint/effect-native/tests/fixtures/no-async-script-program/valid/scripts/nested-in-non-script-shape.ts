import { Effect } from "effect";

// `Effect.runPromise` at the edge, not awaited: still not an async/await program.
const main = Effect.succeed(1);

Effect.runPromise(main).then((value) => {
	console.log(value);
});

// Non-async arrow returning an Effect: the target shape for B3.
export const step = (name: string) => Effect.gen(function* () {
	yield* Effect.annotateLogs(Effect.log("step"), { name });
});
