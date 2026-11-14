// One request issues the gateway assertions a Shell document needs, one per entry, so a page whose remotes read N
// modules does not wait for N separate `/auth/gateway-context` round trips before its first reads. An audience may be
// named up to `DOCUMENT_GATEWAY_ASSERTIONS_PER_AUDIENCE` times: a list that warms its rows' details needs several
// single-use assertions of one module. Same session issuer, same per-assertion binding and lifetime as the single
// endpoint: every assertion carries exactly one audience, its own id and its own scope grant, and the session
// principal; modules still authorize every call. Generic over module ids: the composition names them.
import {
  GatewayAudienceInvalidProblemSchema,
  GatewayAudienceSchema,
  GatewayAuthenticationRequiredProblemSchema,
  GatewayContextResponseSchema,
  GatewayInternalProblemSchema,
  GatewayReloadRequiredProblemSchema,
  GatewayUnavailableProblemSchema,
} from '@app/shared-contracts';
import { HttpApiEndpoint, HttpApiGroup, Schema } from '@modern-js/bff-effect/effect-client';

/** Upper bound on assertions per request, whatever the audiences: one request never mints more. */
export const DOCUMENT_GATEWAY_ASSERTION_LIMIT = 64;
/** Upper bound on assertions of one audience per request. */
export const DOCUMENT_GATEWAY_ASSERTIONS_PER_AUDIENCE = 8;

const mostNamedAudience = (audiences: readonly string[]) =>
  Math.max(0, ...[...Map.groupBy(audiences, (audience) => audience).values()].map((named) => named.length));

export const DocumentGatewayContextsRequestSchema = Schema.Struct({
  /** One entry per assertion asked; an audience named n times is asked n assertions. */
  audiences: Schema.Array(GatewayAudienceSchema).check(
    Schema.isMinLength(1),
    Schema.isMaxLength(DOCUMENT_GATEWAY_ASSERTION_LIMIT),
    Schema.makeFilter((audiences) =>
      mostNamedAudience(audiences) <= DOCUMENT_GATEWAY_ASSERTIONS_PER_AUDIENCE
        ? undefined
        : `an audience may be named at most ${DOCUMENT_GATEWAY_ASSERTIONS_PER_AUDIENCE} times`,
    ),
  ),
  compositionRevision: Schema.String.check(Schema.isPattern(/^[\da-f]{64}$/u)),
});
export type DocumentGatewayContextsRequest = typeof DocumentGatewayContextsRequestSchema.Type;

export const DocumentGatewayAssertionSchema = GatewayContextResponseSchema.mapFields((fields) => ({
  ...fields,
  audience: GatewayAudienceSchema,
}));
export type DocumentGatewayAssertion = typeof DocumentGatewayAssertionSchema.Type;

/** One assertion per requested entry the release admits; an audience it does not admit is left out. */
export const DocumentGatewayContextsResponseSchema = Schema.Struct({
  assertions: Schema.Array(DocumentGatewayAssertionSchema),
});

export const DocumentGatewayApiGroup = HttpApiGroup.make('documentGateway').add(
  HttpApiEndpoint.post('issueDocumentGatewayContexts', '/auth/gateway-contexts', {
    error: [
      GatewayAuthenticationRequiredProblemSchema,
      GatewayAudienceInvalidProblemSchema,
      GatewayReloadRequiredProblemSchema,
      GatewayUnavailableProblemSchema,
      GatewayInternalProblemSchema,
    ],
    payload: DocumentGatewayContextsRequestSchema,
    success: DocumentGatewayContextsResponseSchema,
  }),
);
