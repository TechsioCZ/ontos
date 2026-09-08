// D tier: Promise adapters forced by Node/Drizzle/framework entrypoints, `Layer.orDie` at a
// deliberate startup root, `JSON.stringify` in an external fixture API. None of these is an
// `Effect.gen` body, so the rule never looks at their loops.
import { Effect, Layer } from "effect";

declare const AppLayer: Layer.Layer<never>;
declare const tasks: ReadonlyArray<Effect.Effect<void>>;
declare const database: {
	readonly transaction: <A>(body: (tx: unknown) => Promise<A>) => Promise<A>;
	readonly insert: (tx: unknown, payload: string) => Promise<void>;
};
declare const payloads: readonly string[];

export const RootLayer = Layer.orDie(AppLayer);

// The single outer process seam: `Effect.runPromise` in a plain `async` function.
export const main = async (): Promise<void> => {
	for (const task of tasks) {
		await Effect.runPromise(task);
	}
	await database.transaction(async (tx) => {
		for (const payload of payloads) {
			await database.insert(tx, JSON.stringify({ payload }));
		}
	});
};
