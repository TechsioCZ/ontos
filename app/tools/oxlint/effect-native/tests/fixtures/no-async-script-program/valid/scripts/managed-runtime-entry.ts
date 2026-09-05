import { Effect, Layer, ManagedRuntime } from "effect";

const AppLayer = Layer.empty;
const runtime = ManagedRuntime.make(AppLayer);

const main = Effect.gen(function* () {
	yield* Effect.log("running");
	// Sequential yields, no await anywhere.
	for (const step of [1, 2, 3]) {
		yield* Effect.log("step", { step });
	}
});

// A1 target: capture the runtime and adapt to Promise once at the edge.
const exit = await runtime.runPromiseExit(main);
process.exitCode = exit._tag === "Success" ? 0 : 1;
