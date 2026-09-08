// expect-count: 4
// TS namespaces, abstract classes and long optional chains must not hide a run site.
import { Effect } from "effect";

declare const program: Effect.Effect<string>;

declare global {
	interface Window {
		probe: string;
	}
}

export namespace Wrapper {
	export const value = Effect.runSync(program);
}

export abstract class Base {
	abstract identify(): string;
	protected value = Effect.runSync(program);
}

export const deep = Effect?.runPromise?.(program)
	?.then?.((value) => value)
	?.catch?.(() => Effect.runSync(program));
