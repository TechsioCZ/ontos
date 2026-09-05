import { Layer } from "effect";

import { Effect } from "./local-effect.ts";

/** A module-local object literal is not the `effect` namespace. */
const Fx = { gen: (make: () => void) => make() };

/** `Effect` here is a local module, not `effect`. */
export const local = (id: string) =>
	Effect.gen(function* () {
		void id;
	});

export const literal = (id: string) =>
	Fx.gen(() => {
		void id;
	});

/** A parameter named `Effect` shadows any import. */
export function parameterShadow(Effect: { readonly gen: (make: () => void) => void }, id: string) {
	return Effect.gen(() => {
		void id;
	});
}

export const RuntimeLive = Layer.empty;
