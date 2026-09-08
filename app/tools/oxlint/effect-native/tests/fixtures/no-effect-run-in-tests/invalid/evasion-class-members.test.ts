// expect-count: 7
// Static blocks, field initialisers, private fields, `accessor`, getters and async generators are
// all ordinary member-expression positions.
import { Effect } from "effect";

declare const program: Effect.Effect<string>;

export class Harness {
	static {
		void Effect.runSync(program);
	}
	readonly run = Effect.runPromise;
	#forked = Effect.runFork;
	accessor later = Effect.runCallback;
	get value(): string {
		return Effect.runSync(program);
	}
	async *stream(): AsyncGenerator<string> {
		yield await Effect.runPromise(program);
	}
	async method(): Promise<string> {
		return Effect.runPromise(program);
	}
	peek(): unknown {
		return this.#forked;
	}
}
