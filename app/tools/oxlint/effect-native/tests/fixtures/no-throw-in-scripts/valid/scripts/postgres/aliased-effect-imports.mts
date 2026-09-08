/** Alias and submodule namespace imports must not confuse the Effect.try detection. */
import { Effect as E, Schema as S } from "effect";
import * as Layer from "effect/Layer";
import * as Effect from "effect/Effect";

class RoleBootstrapFailed extends S.TaggedError<RoleBootstrapFailed>()("RoleBootstrapFailed", {
	role: S.String,
	cause: S.Unknown,
}) {}

/** A locally declared `Error` class: it never becomes a throw, so nothing reports. */
class Error {
	readonly _tag = "LocalError";
}

const localSentinel = new Error();

export const bootstrapRole = (role: string) =>
	E.tryPromise({
		try: async () => {
			await Promise.resolve();
			return role.toUpperCase();
		},
		catch: (cause) => new RoleBootstrapFailed({ role, cause }),
	}).pipe(E.tapError((failure) => E.logError(failure._tag, { sentinel: localSentinel._tag })));

export const RoleLayer = Layer.effect(
	// eslint-disable-next-line no-undef -- illustrative tag reference only
	{} as never,
	Effect.succeed({ bootstrapRole }),
);
