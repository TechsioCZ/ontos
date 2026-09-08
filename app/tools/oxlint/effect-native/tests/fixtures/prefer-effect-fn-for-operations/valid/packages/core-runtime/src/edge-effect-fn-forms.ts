import { Effect } from "effect";

/** Curried `Effect.fn` handed an arrow is already instrumented. */
export const find = Effect.fn("ContactOps.find")((id: string) =>
	Effect.gen(function* () {
		yield* Effect.log(id);
	}),
);

export const save = Effect.fnUntraced(function* (id: string) {
	yield* Effect.log(id);
});

export const lazy = Effect.suspend(() =>
	Effect.gen(function* () {
		yield* Effect.log("lazy");
	}),
);

/** A guard before the program is real work, not a lone `Effect.gen`. */
export const guarded = (id: string) => {
	if (id.length === 0) return Effect.void;
	return Effect.gen(function* () {
		yield* Effect.log(id);
	});
};
