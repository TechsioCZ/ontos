// expect-count: 7
import { Effect } from "effect";

interface AuthFailure {
  readonly _tag: string;
  readonly reason?: { readonly _tag: string };
}

/** `||` chain: every branch is its own missing `Match` case, so every branch reports. */
export const isUnavailable = (error: AuthFailure): boolean =>
  error._tag === "AuthenticationUnavailableError" || error._tag === "AuthenticationInternalError";

export const denial = (error: AuthFailure): string =>
  error._tag === "PrincipalResolverUnavailableError" ? "unavailable" : "denied";

export const classify = (error: AuthFailure): string => {
  if (error._tag === "HttpClientError" && error.reason?._tag === "TransportError") return "transport";
  if (error._tag !== "ActionAlreadyCommitted") return "other";
  return "committed";
};

/** A4 names `_tag ===` inside `Effect.catch` explicitly; reported unless `includeErrorCombinators` is off. */
export const recover = (program: Effect.Effect<number, AuthFailure>) =>
  program.pipe(
    Effect.catch((error: AuthFailure) =>
      error._tag === "ActionAlreadyCommitted" ? Effect.succeed(0) : Effect.fail(error),
    ),
  );
