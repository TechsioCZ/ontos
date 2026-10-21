// Shell connect flow of MCP connections (browser, session cookie): screens /cs/pripojit and /cs/pripojit/souhlas.
// Wire schemas live in @app/shared-contracts/oauth-connections; `code` carries a `ConnectProblemCode`.
import {
  ConnectApproveRequestSchema,
  ConnectApproveResponseSchema,
  ConnectDenyRequestSchema,
  ConnectDenyResponseSchema,
  ConnectDraftRequestSchema,
  ConnectDraftResponseSchema,
  ConnectDraftSummaryRequestSchema,
  ConnectDraftSummarySchema,
  ConnectOptionsRequestSchema,
  ConnectOptionsSchema,
} from '@app/shared-contracts/oauth-connections';
import { makeProblemDetailsSchema, makeRetryableProblemDetailsSchema } from '@app/shared-contracts/problem-details';
import { HttpApiEndpoint, HttpApiGroup, Schema } from '@modern-js/bff-effect/effect-client';

export const OAuthConnectInvalidProblemSchema = makeProblemDetailsSchema('OAuthConnectInvalidProblem', 400, {
  code: Schema.String,
});
export const OAuthConnectUnauthorizedProblemSchema = makeProblemDetailsSchema('OAuthConnectUnauthorizedProblem', 401, {
  code: Schema.String,
});
export const OAuthConnectForbiddenProblemSchema = makeProblemDetailsSchema('OAuthConnectForbiddenProblem', 403, {
  code: Schema.String,
});
export const OAuthConnectNotFoundProblemSchema = makeProblemDetailsSchema('OAuthConnectNotFoundProblem', 404, {
  code: Schema.String,
});
export const OAuthConnectUnavailableProblemSchema = makeRetryableProblemDetailsSchema('OAuthConnectUnavailableProblem', 503);

export type OAuthConnectInvalidProblem = typeof OAuthConnectInvalidProblemSchema.Type;
export type OAuthConnectUnauthorizedProblem = typeof OAuthConnectUnauthorizedProblemSchema.Type;
export type OAuthConnectForbiddenProblem = typeof OAuthConnectForbiddenProblemSchema.Type;
export type OAuthConnectNotFoundProblem = typeof OAuthConnectNotFoundProblemSchema.Type;
export type OAuthConnectUnavailableProblem = typeof OAuthConnectUnavailableProblemSchema.Type;
export type OAuthConnectProblem =
  | OAuthConnectInvalidProblem
  | OAuthConnectUnauthorizedProblem
  | OAuthConnectForbiddenProblem
  | OAuthConnectNotFoundProblem
  | OAuthConnectUnavailableProblem;

const oauthConnectErrors = [
  OAuthConnectInvalidProblemSchema,
  OAuthConnectUnauthorizedProblemSchema,
  OAuthConnectForbiddenProblemSchema,
  OAuthConnectNotFoundProblemSchema,
  OAuthConnectUnavailableProblemSchema,
] as const;

export const OAuthConnectApiGroup = HttpApiGroup.make('oauthConnect')
  .add(
    HttpApiEndpoint.post('connectOptions', '/auth/oauth-connections/options', {
      error: oauthConnectErrors,
      payload: ConnectOptionsRequestSchema,
      success: ConnectOptionsSchema,
    }),
  )
  .add(
    HttpApiEndpoint.post('connectDraft', '/auth/oauth-connections/draft', {
      error: oauthConnectErrors,
      payload: ConnectDraftRequestSchema,
      success: ConnectDraftResponseSchema,
    }),
  )
  .add(
    HttpApiEndpoint.post('connectDraftSummary', '/auth/oauth-connections/draft-summary', {
      error: oauthConnectErrors,
      payload: ConnectDraftSummaryRequestSchema,
      success: ConnectDraftSummarySchema,
    }),
  )
  .add(
    HttpApiEndpoint.post('connectApprove', '/auth/oauth-connections/approve', {
      error: oauthConnectErrors,
      payload: ConnectApproveRequestSchema,
      success: ConnectApproveResponseSchema,
    }),
  )
  .add(
    HttpApiEndpoint.post('connectDeny', '/auth/oauth-connections/deny', {
      error: oauthConnectErrors,
      payload: ConnectDenyRequestSchema,
      success: ConnectDenyResponseSchema,
    }),
  );
