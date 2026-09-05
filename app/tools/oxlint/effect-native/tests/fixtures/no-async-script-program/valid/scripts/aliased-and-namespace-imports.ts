import { Effect as E, pipe } from "effect";
import * as EffectNs from "effect/Effect";

// Alias import: `E.tryPromise` still resolves to the exported `Effect.tryPromise`.
export const readFileText = (path: string) =>
	E.tryPromise({
		catch: (cause: unknown) => new Error(String(cause)),
		try: async () => {
			const fs = await import("node:fs/promises");
			// Async closures *inside* a driver edge are Promise-land by construction.
			const read = async (): Promise<string> => fs.readFile(path, "utf8");
			return await read();
		},
	});

// Namespace import of an `effect/*` submodule.
export const now = EffectNs.promise(async () => Date.now());

export const callback = EffectNs.callback<number, never>(async (resume) => {
	resume(EffectNs.succeed(1));
});

// Computed access is resolved too.
export const computed = E["promise"](async () => 2);

const program = E.succeed(1);
// Point-free entry adapter.
const result = await pipe(program, E.runPromise);
console.log(result);
