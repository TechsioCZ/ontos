import { Effect, Layer, Schema } from "effect";

/** D tier: `Layer.orDie` at a deliberate startup root. */
export const RuntimeLive = Layer.orDie(Layer.empty);

/** Preserved: bare `Effect.runPromise` at the single outer process/framework adapter seam. */
export const adapter = (input: string) => Effect.runPromise(Effect.log(input));

/** Preserved: native array operations where Effect collection APIs add no semantic value. */
export const names = (rows: ReadonlyArray<{ readonly name: string }>) => rows.map((row) => row.name);

/** Preserved: Schema-owned contracts. */
export const Contact = Schema.Struct({ id: Schema.String });

/** A zero-argument factory has no arguments to annotate (`minParams: 1`). */
export const make = () =>
	Effect.gen(function* () {
		yield* Effect.log("make");
	});

/** Generators are already the `Effect.fn` shape. */
export function* step(id: string) {
	yield* Effect.log(id);
}
