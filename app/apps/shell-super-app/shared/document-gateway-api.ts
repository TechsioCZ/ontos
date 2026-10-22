// One request issues the gateway assertions a Shell document needs, one per module audience, so a page whose remotes
// read N modules does not wait for N separate `/auth/gateway-context` round trips before its first reads. Same session
// issuer, same per-audience binding and lifetime as the single endpoint: every assertion carries exactly one audience
// and the session principal; modules still authorize every call. Generic over module ids: the composition names them.
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

/** Upper bound on audiences per request; a release composes far fewer module deployments. */
export const DOCUMENT_GATEWAY_AUDIENCE_LIMIT = 64;

export const DocumentGatewayContextsRequestSchema = Schema.Struct({
  audiences: Schema.Array(GatewayAudienceSchema).check(
    Schema.isMinLength(1),
    Schema.isMaxLength(DOCUMENT_GATEWAY_AUDIENCE_LIMIT),
    Schema.makeFilter((audiences) =>
      new Set(audiences).size === audiences.length ? undefined : 'audiences must be unique',
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

/** One assertion per requested audience the release admits; an audience it does not admit is left out. */
export const DocumentGatewayContextsResponseSchema = Schema.Struct({
  assertions: Schema.Array(DocumentGatewayAssertionSchema),
});
export type DocumentGatewayContextsResponse = typeof DocumentGatewayContextsResponseSchema.Type;

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
