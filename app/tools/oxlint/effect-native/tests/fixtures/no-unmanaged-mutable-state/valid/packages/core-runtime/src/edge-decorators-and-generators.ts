// Crash probe: decorators, async generators, `for await`, top-level await and satisfies.
const logged = <This, Args extends readonly unknown[], Return>(
	target: (this: This, ...args: Args) => Return,
): ((this: This, ...args: Args) => Return) => target;

export class Reporter {
	@logged
	run(): string {
		return "ok";
	}
}

export async function* pages(count: number): AsyncGenerator<number> {
	for (let index = 0; index < count; index += 1) yield index;
}

export const drain = async (source: AsyncIterable<number>): Promise<number> => {
	let total = 0;
	for await (const value of source) total += value;
	return total;
};

export const defaults = { retries: 3 } satisfies Readonly<Record<string, number>>;

export const boot = await Promise.resolve("ready");
