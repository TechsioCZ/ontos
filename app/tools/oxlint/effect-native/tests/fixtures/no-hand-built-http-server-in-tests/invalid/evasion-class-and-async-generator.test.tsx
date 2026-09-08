// Unpinned on purpose: `this.#server.listen(0)` on a private field is not tracked today.
import * as http from "node:http";

export class Harness {
	readonly #server = http.createServer(() => {});

	async *ports(): AsyncGenerator<number> {
		const nested = () => {
			const inner = http["createServer"](() => {});
			inner?.listen(0);
			return inner;
		};
		nested();
		this.#server!.listen(0);
		yield 0;
	}
}

export const Probe = () => <span>probe</span>;
