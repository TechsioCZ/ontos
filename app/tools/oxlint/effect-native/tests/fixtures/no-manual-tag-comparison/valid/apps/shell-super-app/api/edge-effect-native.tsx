import { Match, Schema } from "effect";

class GatewayProblem extends Schema.TaggedError<GatewayProblem>()("GatewayAuthenticationRequiredProblem", {}) {}

/** Type-level `_tag` inside a TSX file is still the Schema-owned vocabulary, never a comparison. */
export type TagOf<P extends { readonly _tag: string }> = P["_tag"];
export type WithoutGateway<P extends { readonly _tag: string }> = Exclude<
  P,
  { readonly _tag: "GatewayAuthenticationRequiredProblem" }
>;

export function Badge({ error }: { readonly error: unknown }) {
  const label = Match.value(error).pipe(
    Match.tag("GatewayAuthenticationRequiredProblem", () => "auth"),
    Match.tags({ TenantAccessForbiddenError: () => "forbidden" }),
    Match.orElse(() => "other"),
  );
  return <span data-guard={Schema.is(GatewayProblem)(error)}>{label}</span>;
}

/** Constructing and annotating a tag is not a comparison. */
export const annotate = (error: { readonly _tag: string }) => ({
  failureTag: error._tag,
  next: { _tag: error._tag },
});
