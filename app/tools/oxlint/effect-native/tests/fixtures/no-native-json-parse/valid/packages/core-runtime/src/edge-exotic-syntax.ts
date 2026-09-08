// Parser-stress file: import attributes, enum, `using`, `satisfies`, labels, abstract classes,
// decorators on methods. No `JSON.parse` anywhere, so nothing may report and nothing may crash.
import document from "./topology.json" with { type: "json" };

declare const s: string;
declare function log(target: unknown, context: unknown): void;

export enum Kind {
	A = "a",
	B = "b",
}

export const dispose = () => {
	using handle = {
		[Symbol.dispose]() {},
	};
	void handle;
	return document;
};

export const config = { kind: Kind.A } satisfies { readonly kind: Kind };
export abstract class Base<T = never> {
	abstract read(): T;

	@log
	describe() {
		return s;
	}
}

export function labelled() {
	outer: for (const value of [1, 2]) {
		if (value === 1) continue outer;
		break outer;
	}
	return s;
}
