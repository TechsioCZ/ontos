import { Effect, Layer, ManagedRuntime, pipe } from "effect";

const main = Effect.gen(function* () {
	yield* Effect.log("point-free entry");
	return 1;
});

const runtime = ManagedRuntime.make(Layer.empty);

// Every blessed shape of the single process adapter.
const viaPipe = await pipe(main, Effect.runPromise);
const viaMethod = await main.pipe(Effect.runPromiseExit);
const viaRuntime = await runtime.runPromiseExit(main);
const viaCast = await (Effect.runPromise(main) as Promise<number>);

console.log(viaPipe, viaMethod, viaRuntime, viaCast);
