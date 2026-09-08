// expect-count: 4
// Audit correction: immediately reading an empty weak collection retains no state; it is not
// A4/C3 storage (D tier preserves native computation). The four stored/returned allocations
// below remain candidate side channels regardless of their nesting depth.
export const label = `${String(new WeakSet<object>().has({}))}`;

export const withDefault = (seen: WeakSet<object> = new WeakSet<object>()): boolean => seen.has({});

export class Channel {
	private readonly causes = new WeakMap<Error, unknown>();

	remember(error: Error, cause: unknown): void {
		this.causes.set(error, cause);
	}
}

export const channels = { causes: new WeakMap<Error, unknown>() };

export async function* drain(): AsyncGenerator<WeakSet<object>> {
	yield new WeakSet<object>();
}
