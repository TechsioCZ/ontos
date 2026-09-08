const enumeration = { a: 1n, b: 1_000 } as const;

export class Exotic {
	static #count = 0n;

	static {
		Exotic.#count += 1n;
	}

	accessor label = `exotic-${String(enumeration.b)}`;

	*rows(): Generator<number> {
		yield enumeration.b;
	}

	async drain(source: AsyncIterable<number>): Promise<number> {
		let total = 0;
		for await (const row of source) total += row;
		try {
			total += Number(/^[0-9a-f]{8}$/dgimsuy.source.length);
		} catch {
			total = 0;
		}
		outer: for (const _ of [1]) break outer;
		return total;
	}
}

export const meta = import.meta.url;
