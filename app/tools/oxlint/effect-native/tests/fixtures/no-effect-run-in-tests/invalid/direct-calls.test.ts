// expect-count: 6
import { Effect, Exit, pipe } from "effect";

declare const program: Effect.Effect<string>;
declare const it: (name: string, body: () => Promise<void> | void) => void;

it("resolves", async () => {
	const value = await Effect.runPromise(program);
	const exit = await Effect.runPromiseExit(program);
	const sync = Effect.runSync(program);
	const forked = Effect.runFork(program);
	const chained = Effect?.runSyncExit(program);
	const pointFree = pipe(program, Effect.runPromise);
	console.log(value, Exit.isSuccess(exit), sync, forked, chained, pointFree);
});
