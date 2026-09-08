import { Effect } from "effect";

/** `scripts/**` is out of scope by default (`includeScripts: false`). */
export const migrateTenant = (id: string) =>
	Effect.gen(function* () {
		yield* Effect.log(id);
	});
