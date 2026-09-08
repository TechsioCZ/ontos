import { Effect } from "effect";

/** Target state: a named span, call-site trace and captured arguments. */
export const resolve = Effect.fn("Resolver.resolve")(function* (input: string) {
	yield* Effect.log(input);
});

/** `Effect.fnUntraced` is the deliberate opt-out, not the anti-pattern. */
export const untraced = Effect.fnUntraced(function* (input: string) {
	yield* Effect.log(input);
});

/** Suspensions carry no arguments to annotate. */
export const lazy = Effect.suspend(() =>
	Effect.gen(function* () {
		yield* Effect.log("lazy");
	}),
);

/** A top-level program is not an operation wrapper. */
export const program = Effect.gen(function* () {
	yield* Effect.log("start");
});

/** A body that does real work is not a lone `Effect.gen`. */
export const guarded = (id: string) => {
	if (id.length === 0) return Effect.void;
	return Effect.gen(function* () {
		yield* Effect.log(id);
	});
};

/** A locally shadowed `Effect` is not the `effect` import. */
export function shadowed(Effect: { readonly gen: (make: () => void) => void }, id: string) {
	return Effect.gen(() => {
		void id;
	});
}

/** An unrelated `gen` member. */
const codegen = { gen: (make: () => void) => make };
export const generate = (id: string) =>
	codegen.gen(() => {
		void id;
	});
