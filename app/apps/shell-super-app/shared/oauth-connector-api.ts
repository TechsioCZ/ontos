// Connector endpoints of MCP connections (server-to-shell, `x-ontos-connector-key` + user Bearer token). Wire schemas
// live in @app/shared-contracts/oauth-connections; 401 means re-authenticate, 403 a tool error, 409 re-describe.
import {
  ConnectionDescriptionSchema,
  ConnectorDescribeRequestSchema,
  ConnectorGatewayContextRequestSchema,
  ConnectorGatewayContextResponseSchema,
} from '@app/shared-contracts/oauth-connections';
import { makeProblemDetailsSchema, makeRetryableProblemDetailsSchema } from '@app/shared-contracts/problem-details';
import { HttpApiEndpoint, HttpApiGroup, Schema } from '@modern-js/bff-effect/effect-client';

export const ConnectorHeadersSchema = Schema.Struct({
  authorization: Schema.optionalKey(Schema.String),
  'x-ontos-connector-key': Schema.optionalKey(Schema.String),
});

export const ConnectorUnauthorizedProblemSchema = makeProblemDetailsSchema('ConnectorUnauthorizedProblem', 401, {
  code: Schema.String,
});
export const ConnectorForbiddenProblemSchema = makeProblemDetailsSchema('ConnectorForbiddenProblem', 403, {
  code: Schema.String,
});
export const ConnectorReloadRequiredProblemSchema = makeProblemDetailsSchema('ConnectorReloadRequiredProblem', 409, {
  code: Schema.String,
});
export const ConnectorUnavailableProblemSchema = makeRetryableProblemDetailsSchema('ConnectorUnavailableProblem', 503);
export const ConnectorInternalProblemSchema = makeProblemDetailsSchema('ConnectorInternalProblem', 500, {
  code: Schema.String,
});

export type ConnectorUnauthorizedProblem = typeof ConnectorUnauthorizedProblemSchema.Type;
export type ConnectorForbiddenProblem = typeof ConnectorForbiddenProblemSchema.Type;
export type ConnectorReloadRequiredProblem = typeof ConnectorReloadRequiredProblemSchema.Type;
export type ConnectorUnavailableProblem = typeof ConnectorUnavailableProblemSchema.Type;
export type ConnectorInternalProblem = typeof ConnectorInternalProblemSchema.Type;
export type ConnectorProblem =
  | ConnectorUnauthorizedProblem
  | ConnectorForbiddenProblem
  | ConnectorReloadRequiredProblem
  | ConnectorUnavailableProblem
  | ConnectorInternalProblem;

const connectorErrors = [
  ConnectorUnauthorizedProblemSchema,
  ConnectorForbiddenProblemSchema,
  ConnectorReloadRequiredProblemSchema,
  ConnectorUnavailableProblemSchema,
  ConnectorInternalProblemSchema,
] as const;

export const OAuthConnectorApiGroup = HttpApiGroup.make('oauthConnector')
  .add(
    HttpApiEndpoint.post('connectorDescribe', '/auth/connector/describe', {
      error: connectorErrors,
      headers: ConnectorHeadersSchema,
      payload: ConnectorDescribeRequestSchema,
      success: ConnectionDescriptionSchema,
    }),
  )
  .add(
    HttpApiEndpoint.post('connectorGatewayContext', '/auth/connector/gateway-context', {
      error: connectorErrors,
      headers: ConnectorHeadersSchema,
      payload: ConnectorGatewayContextRequestSchema,
      success: ConnectorGatewayContextResponseSchema,
    }),
  );
