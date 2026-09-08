import { Effect, pipe } from 'effect';

declare function log(target: unknown, key: string): void;
declare function open(): Disposable;

const label = 'stress' as const;

export class Box<A> {
	static #count = 0;
	static {
		Box.#count = 1;
	}
	accessor value: A | undefined = undefined;
	@log
	run(): void {
		using resource = open();
		void resource;
	}
	async *items(): AsyncGenerator<string> {
		yield `${label}`;
	}
}

export const view = () => <div data-label={`${label}`}>{String(Box.name)}</div>;
export const program = pipe(
	Effect.void,
	Effect.map(() => ({ label }) satisfies { label: string }),
);
