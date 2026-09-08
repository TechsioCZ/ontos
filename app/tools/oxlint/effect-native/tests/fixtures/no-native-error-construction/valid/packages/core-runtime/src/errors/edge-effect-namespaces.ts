// Aliased and namespace imports of `effect` submodules, point-free pipe seams, private fields and
// `super` member access: none of these is a native error constructor.
import * as Cause from "effect/Cause";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import { runPromise } from "effect/Effect";
import { pipe } from "effect/Function";

export class Boom extends Data.TaggedError("Boom")<{ readonly reason: string }> {}

export const failure = Effect.fail(new Boom({ reason: "typed" }));

export const defect = Effect.failCause(Cause.die("typed defect"));

export const seam = pipe(failure, Effect.orDie, runPromise);

class Base {
	protected describe(): string {
		return "base";
	}
}

export class Child extends Base {
	readonly #secret = "s";

	override describe(): string {
		return `${super.describe()}:${this.#secret}:${import.meta.url}`;
	}
}
