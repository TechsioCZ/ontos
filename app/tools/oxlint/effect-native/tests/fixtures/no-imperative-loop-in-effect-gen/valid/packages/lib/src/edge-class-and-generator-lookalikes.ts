// Decorators, `accessor`, a class static block, an object-literal method generator, a namespace
// declaration and a `for await` in a plain async function. None is an `Effect.gen` body.
import { Effect } from "effect";

declare const decorate: (target: unknown, context: unknown) => void;
declare const actions: readonly string[];
declare const step: (action: string) => Generator<unknown, void>;
declare const pages: AsyncIterable<string>;
declare const probe: Effect.Effect<void>;

export class Runner {
	@decorate accessor label: string = "runner";

	static registry: string[] = [];

	static {
		for (const action of actions) {
			Runner.registry.push(action);
		}
	}

	*walk(): Generator<unknown, void> {
		for (const action of actions) {
			yield* step(action);
		}
	}
}

export const bag = {
	*walk(): Generator<unknown, void> {
		for (const action of actions) {
			yield* step(action);
		}
	},
};

export const consume = async (): Promise<number> => {
	let seen = 0;
	for await (const page of pages) {
		seen += page.length;
	}
	return seen;
};

export namespace Legacy {
	export const still = Effect.runPromise(probe);
}
