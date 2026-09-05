// expect-count: 4
import { Effect } from 'effect';

declare const load: (id: string) => Effect.Effect<string>;
declare const ids: readonly string[];

export async function* stream(): AsyncGenerator<string> {
	for (const id of ids) yield await Effect.runPromise(load(id));
}

export class Registry {
	static readonly boot = Effect.runSync(load('boot'));

	static {
		void Effect.runFork(load('static'));
	}

	readonly run = Effect.runSync;
}
