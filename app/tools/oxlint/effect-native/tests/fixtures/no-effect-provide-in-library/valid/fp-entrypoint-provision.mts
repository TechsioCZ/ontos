import { Effect, pipe } from "effect";
import { runPromise as run } from "effect/Effect";
declare const program: Effect.Effect<void>;
declare const Live: never;
// These are syntactically equivalent outer process seams, not service-local wiring.
await program.pipe(Effect.provide(Live), Effect.runPromise);
await pipe(program, Effect.provide(Live), Effect.runPromise);
await Effect.provide(program, Live).pipe(Effect.runPromise);
await run(Effect.provide(program, Live));
const runnable = program.pipe(Effect.provide(Live));
await Effect.runPromise(runnable);
async function main() { await Effect.runPromise(program.pipe(Effect.provide(Live))); }
await main();
const boot = async () => await program.pipe(Effect.provide(Live), Effect.runPromise);
await boot();
await (async () => { await Effect.runPromise(Effect.provide(program, Live)); })();
