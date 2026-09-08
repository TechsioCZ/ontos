// expect-count: 4
import { Effect, pipe } from "effect";

export const CustomerContactPersistence = {
	lookup: (id: string) =>
		Effect.gen(function* () {
			yield* Effect.log(id);
		}),
	upsert(input: { readonly id: string }) {
		return Effect.gen(function* () {
			yield* Effect.log(input.id);
		});
	},
};

export class ContactRepository {
	find(id: string) {
		return Effect.gen(function* () {
			yield* Effect.log(id);
		});
	}
}

/** Point-free `pipe(program, …)`: the returned program is still a bare Effect.gen. */
export const archive = (id: string) =>
	pipe(
		Effect.gen(function* () {
			yield* Effect.log(id);
		}),
		Effect.withSpan("CustomerContactPersistence.archive"),
	);
