import { Effect } from "effect";
import * as Fx from "effect/Effect";

// Optional-chained driver edge.
export const optional = Effect?.tryPromise({
	catch: (cause: unknown) => new Error(String(cause)),
	try: async () => 1,
});

// Computed driver edge on a submodule namespace import.
export const computed = Fx["callback"]<number, never>(async (resume) => {
	resume(Fx.succeed(1));
});

// Quoted `try` key, and async closures nested inside the Promise seam.
export const quoted = Effect.tryPromise({
	catch: String,
	"try": async () => {
		const inner = async (): Promise<number> => 2;
		const deeper = { async step(): Promise<number> { return inner(); } };
		return await deeper.step();
	},
});
