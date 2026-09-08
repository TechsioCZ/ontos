// expect-count: 12
const render = (label: string) => <span>{label}</span>;

export const validate = (value: unknown): string =>
	typeof value === "string"
		? value
		: ((): never => {
				throw new Error("not a string");
			})();

export const nested = () => () => () => {
	throw new TypeError("deeply nested arrow body");
};

export class ContractChecker {
	static {
		if (globalThis.process === undefined) throw new Error("no process");
	}

	#id: string;

	constructor(id: string) {
		if (id === "") throw new RangeError("empty id");
		this.#id = id;
	}

	get id(): string {
		if (this.#id === "") throw new Error("id unset");
		return this.#id;
	}

	set id(next: string) {
		void next;
		throw new Error("id is read-only");
	}

	async *stream(): AsyncGenerator<string> {
		yield this.#id;
		throw new Error("stream exhausted");
	}

	static async load(): Promise<ContractChecker> {
		try {
			return new ContractChecker("x");
		} catch (error) {
			throw error;
		}
	}
}

export const handlers = {
	fail(reason: string): never {
		throw new Error(reason);
	},
	get broken(): never {
		throw new Error("broken");
	},
};

export function pick(kind: string): string {
	switch (kind) {
		case "a":
			return "a";
		default:
			throw new Error(`unknown kind ${kind}`);
	}
}

export const element = (ok: boolean) =>
	ok
		? render("ok")
		: (() => {
				throw new Error("render failed");
			})();
