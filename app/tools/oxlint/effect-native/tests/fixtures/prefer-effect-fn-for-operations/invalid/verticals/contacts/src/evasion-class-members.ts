// expect-count: 4
import { Effect } from "effect";

export class ContactRepository {
	readonly handle = (input: { readonly id: string }) =>
		Effect.gen(function* () {
			yield* Effect.log(input.id);
		});

	static create(id: string) {
		return Effect.gen(function* () {
			yield* Effect.log(id);
		});
	}

	#load(id: string) {
		return Effect.gen(function* () {
			yield* Effect.log(id);
		});
	}

	find(id: string): unknown;
	find(id: string, tenant: string): unknown;
	find(id: string, tenant?: string) {
		const key = tenant === undefined ? id : `${tenant}/${id}`;
		return Effect.gen(function* () {
			yield* Effect.log(key);
		});
	}

	use(id: string) {
		return this.#load(id);
	}
}
