import { Effect } from "effect";

/** Tests are out of scope by default (`includeTests: false`). */
export const makeStub = (id: string) =>
	Effect.gen(function* () {
		yield* Effect.log(id);
	});
