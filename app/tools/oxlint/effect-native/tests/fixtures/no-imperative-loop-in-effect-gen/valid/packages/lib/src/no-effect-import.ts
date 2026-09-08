// No `effect` import at all: nothing to analyse.
declare const items: readonly string[];
declare const handle: (item: string) => Generator<unknown, void>;

export function* iterate(): Generator<unknown, void> {
	for (const item of items) {
		yield* handle(item);
	}
}
