// expect-count: 3
// Class bodies are not the executable edge: method, property arrow and static block all report.
import { Effect } from "effect";

const program = Effect.succeed(1);

export class Migrator {
	readonly boot = async (): Promise<number> => await Effect.runPromise(program);

	async migrate(): Promise<number> {
		return await Effect.runPromise(program);
	}

	static {
		void Effect.runFork(program);
	}
}
