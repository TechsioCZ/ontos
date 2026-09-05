// expect-count: 3
import { Effect } from 'effect';

declare const load: (id: string) => Effect.Effect<string>;
declare const ids: readonly string[];

/** Class methods, plain array callbacks and try/catch bodies are not Effect-owned code. */
export class ReadServerSupport {
	async read(id: string): Promise<string> {
		return await Effect.runPromise(load(id));
	}

	readAll(): readonly string[] {
		return ids.map((id) => Effect.runSync(load(id)));
	}
}

export const readOrNull = (id: string): string | null => {
	try {
		return Effect.runSync(load(id));
	} catch {
		return null;
	}
};
