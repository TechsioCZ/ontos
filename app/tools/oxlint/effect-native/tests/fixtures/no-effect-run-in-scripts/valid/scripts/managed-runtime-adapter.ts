// A1's prescribed shape: one ManagedRuntime captured at the script root, `runtime.runPromise` at the
// forced Promise adapters, and one `Effect.runPromiseExit` at the process-exit seam.
import { Effect, Exit, Layer, ManagedRuntime } from "effect";
import { pathToFileURL } from "node:url";

const startupLayer = Layer.orDie(Layer.succeed("config" as const, { url: "postgres://localhost/ontos" }));
const runtime = ManagedRuntime.make(startupLayer);

const forcedAdapter = async (): Promise<number> => await runtime.runPromise(Effect.succeed(1));

void forcedAdapter;

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
	const exit = await Effect.runPromiseExit(Effect.succeed("done"));
	process.exitCode = Exit.isSuccess(exit) ? 0 : 1;
}
