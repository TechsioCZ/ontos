/** Exotic-but-inert syntax: the rule must walk it without crashing and without reporting. */
export type PortKey = `port:${string}`;

export type PortTable = Readonly<Record<PortKey, number>>;

export const rows = await Promise.resolve([] as readonly string[]);

export const Cache = class {
	static {
		void 0;
	}

	#hits = 0;

	hit(): number {
		this.#hits += 1;
		return this.#hits;
	}
};

export enum Never {}

declare module "virtual:ports" {
	export const version: string;
}

export const table = { a: 1 } satisfies Record<string, number>;
