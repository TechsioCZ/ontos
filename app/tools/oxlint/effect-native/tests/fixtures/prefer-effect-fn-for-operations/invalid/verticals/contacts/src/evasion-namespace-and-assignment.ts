// expect-count: 3
import { Effect } from "effect";

export namespace ContactOps {
	export const find = (id: string) =>
		Effect.gen(function* () {
			yield* Effect.log(id);
		});
}

export const registry: Record<string, unknown> = {};

registry.archive = (id: string) =>
	Effect.gen(function* () {
		yield* Effect.log(id);
	});

export default (id: string) =>
	Effect.gen(function* () {
		yield* Effect.log(id);
	});
