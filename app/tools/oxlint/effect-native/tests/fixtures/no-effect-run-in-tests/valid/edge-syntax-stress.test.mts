// Pathological-but-legal syntax must not crash the rule: no Effect run site here.
declare module "node:util" {
	interface Probe {
		id: string;
	}
}

export enum Mode {
	A = "a",
	B = "b",
}

declare const makeResource: () => Disposable;
declare const chunks: AsyncIterable<string>;

export async function main(): Promise<Mode> {
	using resource = makeResource();
	void resource;
	for await (const chunk of chunks) void chunk;
	outer: for (const value of [] as readonly string[]) {
		void value;
		break outer;
	}
	return Mode.A;
}
