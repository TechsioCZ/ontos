import { Effect, Exit, Layer } from "effect";
import { pathToFileURL } from "node:url";

// D tier: `Layer.orDie` at a deliberate startup boundary is blessed by the audit.
const startupLayer = Layer.orDie(Layer.succeed("config" as const, { url: "postgres://localhost/ontos" }));

const program = Effect.provide(Effect.succeed("done"), startupLayer);

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
	const exit = await Effect.runPromiseExit(program);
	process.exitCode = Exit.isSuccess(exit) ? 0 : 1;
}
