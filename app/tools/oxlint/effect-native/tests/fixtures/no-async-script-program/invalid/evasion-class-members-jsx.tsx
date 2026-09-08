// expect-count: 9
// Async class members, private methods, accessors, decorators and JSX callbacks.
import { Effect } from "effect";

declare const dec: (target: unknown, key?: unknown) => void;
declare const emit: (handler: () => Promise<void>) => void;

class Runner {
	static async build(): Promise<Runner> {
		return new Runner();
	}
	async *stream(): AsyncGenerator<number> {
		yield 1;
	}
	async #secret(): Promise<void> {}
	private handler = async (): Promise<void> => {
		await this.#secret();
	};
	accessor loader = async (): Promise<number> => 1;
	run = async function (this: Runner): Promise<void> {};
}

@dec
class Decorated {
	async go(): Promise<void> {}
}

export const Panel = (): JSX.Element => (
	<button onClick={async () => { await Promise.resolve(); }} type="button">
		go
	</button>
);

emit(async () => {});

void Runner;
void Decorated;
void Effect.void;
