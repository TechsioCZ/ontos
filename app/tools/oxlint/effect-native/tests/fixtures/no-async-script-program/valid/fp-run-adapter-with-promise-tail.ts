// FALSE POSITIVE regression fixture (must not report).
//
// The audit blesses "one small process-exit adapter at the executable edge"
// (B3 + "Existing patterns to preserve"). Attaching `.catch` / `.then` /
// `.finally` to that adapter is the same single adapter, not a second
// Promise program — the awaited expression still *is* `Effect.run*(main)`.
//
// Today `isRunAdapterExpression` only looks at the outermost call, so a
// Promise tail makes the callee `<...>.catch` and the top-level await is
// reported as `topLevelAwait`.
import { Effect } from "effect";

const main = Effect.succeed(1);

await Effect.runPromise(main).catch((error: unknown) => {
	console.error(error);
	process.exitCode = 1;
});

await Effect.runPromise(main).then((value) => {
	console.log(value);
});

await Effect.runPromiseExit(main).finally(() => {
	console.log("done");
});
