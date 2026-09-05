// Parameters, catch bindings and destructured fields named `Effect` shadow the import.
import { Effect } from "effect";

declare const program: Effect.Effect<string>;

export function withParameter(Effect: { runPromise: (p: unknown) => Promise<unknown> }): Promise<unknown> {
	return Effect.runPromise(program);
}

export function withCatch(): unknown {
	try {
		return 1;
	} catch (Effect) {
		return (Effect as { runSync: (p: unknown) => unknown }).runSync(program);
	}
}

export class Holder {
	constructor(private readonly Effect: { runFork: (p: unknown) => unknown }) {}
	go(): unknown {
		const { Effect } = this;
		return Effect.runFork(program);
	}
}
