// expect-count: 6
import { Effect as Fx } from "effect";
import * as EffectNs from "effect/Effect";
import * as Root from "effect";
import { gen as effectGen } from "effect/Effect";

/** `import { Effect as Fx } from "effect"` */
export const aliased = (id: string) =>
	Fx.gen(function* () {
		yield* Fx.log(id);
	});

/** `import * as EffectNs from "effect/Effect"` */
export const submodule = (id: string) =>
	EffectNs.gen(function* () {
		yield* EffectNs.log(id);
	});

/** `import * as Root from "effect"` → `Root.Effect.gen` */
export const rootNamespace = (id: string) =>
	Root.Effect.gen(function* () {
		yield* Root.Effect.log(id);
	});

/** Computed member access. */
export const computed = (id: string) =>
	Fx["gen"](function* () {
		yield* Fx.log(id);
	});

/** Optional chaining. */
export const optional = (id: string) =>
	Fx?.gen(function* () {
		yield* Fx.log(id);
	});

/** `import { gen } from "effect/Effect"` */
export const direct = (id: string) =>
	effectGen(function* () {
		yield* Fx.log(id);
	});
