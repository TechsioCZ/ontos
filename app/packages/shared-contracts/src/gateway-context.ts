// eslint-disable-next-line anti-slop-effect/no-service-constructor-imports -- These pure helpers construct contract schemas, not Effect services.
import { makeProblemDetailsSchema, makeRetryableProblemDetailsSchema } from './problem-details.ts';
import {
  Effect,
  HttpApi,
  HttpApiEndpoint,
  HttpApiGroup,
  Schema,
  makeEffectHttpApiClient,
} from '@modern-js/plugin-bff/effect-client';
import type { HttpApiClient, HttpClientError } from '@modern-js/plugin-bff/effect-client';
import { TrustedPrincipalContextSchema } from '@app/core-runtime/actions/principal-context';
import type { TrustedPrincipalContext } from '@app/core-runtime/actions/principal-context';
import { Context } from 'effect';
import { HttpClient, HttpClientRequest } from 'effect/unstable/http';

export const GATEWAY_ASSERTION_VERSION = 1 as const;
export const GATEWAY_ASSERTION_TTL_SECONDS = 300 as const;
export const GATEWAY_ASSERTION_CLOCK_SKEW_SECONDS = 30 as const;

const nonEmptyString = Schema.String.check(Schema.isMinLength(1));
const uuid = Schema.String.check(Schema.isUUID());
const LegalEntityIdSchema = uuid.pipe(Schema.brand('LegalEntityId'));
const epochSeconds = Schema.Finite.check(Schema.isInt(), Schema.isGreaterThanOrEqualTo(0));
export const GatewayAudienceSchema = nonEmptyString.check(
  Schema.makeFilter((value) =>
    /^[a-z][a-z0-9]*(?:[.-][a-z0-9]+)*$/u.test(value)
      ? undefined
      : 'audience must be a stable topology app ID',
  ),
);

export const GatewayTrustedPrincipalContextSchema = TrustedPrincipalContextSchema;

export type GatewayTrustedPrincipalContext = TrustedPrincipalContext;

export const GatewayContextProtectedHeaderSchema = Schema.Struct({
  alg: Schema.Literal('EdDSA'),
  kid: nonEmptyString,
  typ: Schema.Literal('JWT'),
});

export type GatewayContextProtectedHeader = Schema.Schema.Type<
  typeof GatewayContextProtectedHeaderSchema
>;

export const GatewayContextClaimsSchema = Schema.Struct({
  aud: GatewayAudienceSchema,
  exp: epochSeconds,
  iat: epochSeconds,
  iss: nonEmptyString,
  jti: uuid,
  principal: GatewayTrustedPrincipalContextSchema,
  sub: uuid,
  ver: Schema.Literal(GATEWAY_ASSERTION_VERSION),
}).check(
  Schema.makeFilter((claims) => {
    const issues: Schema.FilterIssue[] = [];
    if (claims.exp <= claims.iat) {
      issues.push({ issue: 'exp must be greater than iat', path: ['exp'] });
    }
    if (claims.exp - claims.iat !== GATEWAY_ASSERTION_TTL_SECONDS) {
      issues.push({ issue: 'exp must be exactly 300 seconds after iat', path: ['exp'] });
    }
    if (claims.sub !== claims.principal.principalId) {
      issues.push({ issue: 'sub must equal principal.principalId', path: ['sub'] });
    }
    return issues;
  }),
);

export type GatewayContextClaims = Schema.Schema.Type<typeof GatewayContextClaimsSchema>;

export const decodeGatewayContextClaims = Schema.decodeUnknownEffect(GatewayContextClaimsSchema, {
  onExcessProperty: 'error',
});

export const decodeGatewayContextProtectedHeader = Schema.decodeUnknownEffect(
  GatewayContextProtectedHeaderSchema,
  { onExcessProperty: 'error' },
);

export const GatewayContextRequestSchema = Schema.Struct({
  audience: GatewayAudienceSchema,
  legalEntityId: Schema.optionalKey(LegalEntityIdSchema),
});
export type GatewayContextRequest = typeof GatewayContextRequestSchema.Encoded;

export const GatewayContextResponseSchema = Schema.Struct({
  expiresAt: epochSeconds,
  token: nonEmptyString,
});
export type GatewayContextResponse = Schema.Schema.Type<typeof GatewayContextResponseSchema>;

export const GatewayAuthenticationRequiredProblemSchema = makeProblemDetailsSchema(
  'GatewayAuthenticationRequiredProblem',
  401,
);

export const GatewayAudienceInvalidProblemSchema = makeProblemDetailsSchema(
  'GatewayAudienceInvalidProblem',
  400,
);

export const GatewayUnavailableProblemSchema = makeRetryableProblemDetailsSchema(
  'GatewayUnavailableProblem',
  503,
);

export const GatewayInternalProblemSchema = makeProblemDetailsSchema('GatewayInternalProblem', 500);
const GatewayForbiddenProblemSchema = makeProblemDetailsSchema('GatewayForbiddenProblem', 403);
export const GatewayRateLimitedProblemSchema = makeProblemDetailsSchema(
  'GatewayRateLimitedProblem',
  429,
  {
    retryAfterSeconds: Schema.Finite,
  },
);

export type GatewayAuthenticationRequiredProblem = Schema.Schema.Type<
  typeof GatewayAuthenticationRequiredProblemSchema
>;
export type GatewayAudienceInvalidProblem = Schema.Schema.Type<
  typeof GatewayAudienceInvalidProblemSchema
>;
export type GatewayUnavailableProblem = Schema.Schema.Type<typeof GatewayUnavailableProblemSchema>;
export type GatewayInternalProblem = Schema.Schema.Type<typeof GatewayInternalProblemSchema>;
type GatewayForbiddenProblem = Schema.Schema.Type<typeof GatewayForbiddenProblemSchema>;
type GatewayRateLimitedProblem = Schema.Schema.Type<typeof GatewayRateLimitedProblemSchema>;

export type GatewayContextProblem =
  | GatewayAuthenticationRequiredProblem
  | GatewayAudienceInvalidProblem
  | GatewayForbiddenProblem
  | GatewayRateLimitedProblem
  | GatewayUnavailableProblem
  | GatewayInternalProblem;

export const ApiKeyGatewayHeadersSchema = Schema.Struct({
  'x-api-key': Schema.optionalKey(Schema.String),
});

export const GatewayContextApiGroup = HttpApiGroup.make('gatewayContext')
  .add(
    HttpApiEndpoint.post('issueGatewayContext', '/auth/gateway-context', {
      error: [
        GatewayAuthenticationRequiredProblemSchema,
        GatewayAudienceInvalidProblemSchema,
        GatewayForbiddenProblemSchema,
        GatewayUnavailableProblemSchema,
        GatewayInternalProblemSchema,
      ],
      payload: GatewayContextRequestSchema,
      success: GatewayContextResponseSchema,
    }),
  )
  .add(
    HttpApiEndpoint.post('issueApiKeyGatewayContext', '/auth/api-key/gateway-context', {
      error: [
        GatewayAuthenticationRequiredProblemSchema,
        GatewayAudienceInvalidProblemSchema,
        GatewayForbiddenProblemSchema,
        GatewayRateLimitedProblemSchema,
        GatewayUnavailableProblemSchema,
        GatewayInternalProblemSchema,
      ],
      headers: ApiKeyGatewayHeadersSchema,
      payload: GatewayContextRequestSchema,
      success: GatewayContextResponseSchema,
    }),
  );

export const GatewayContextApi = HttpApi.make('shellGatewayContextApi').add(GatewayContextApiGroup);

export const shellGatewayContextContract = {
  apiPrefix: '/shell-super-app-api',
  issueApiKeyGatewayContextPath: '/shell-super-app-api/auth/api-key/gateway-context',
  issueGatewayContextPath: '/shell-super-app-api/auth/gateway-context',
  ownerId: 'shell-super-app',
} as const;

export const gatewayContextAuthorizationEntrypoints = [
  {
    authorization: { credential: 'session', kind: 'capability_issuance' },
    deployment: shellGatewayContextContract.ownerId,
    entrypointKey: 'shell.gateway-context.issue.session',
    owner: shellGatewayContextContract.ownerId,
    path: shellGatewayContextContract.issueGatewayContextPath,
    surface: 'capability_issuance',
  },
  {
    authorization: { credential: 'api_key', kind: 'capability_issuance' },
    deployment: shellGatewayContextContract.ownerId,
    entrypointKey: 'shell.gateway-context.issue.api-key',
    owner: shellGatewayContextContract.ownerId,
    path: shellGatewayContextContract.issueApiKeyGatewayContextPath,
    surface: 'capability_issuance',
  },
] as const;

type GatewayContextApiGroups =
  typeof GatewayContextApi extends HttpApi.HttpApi<infer _ApiId, infer Groups> ? Groups : never;

type GatewayContextClient = HttpApiClient.Client<
  Extract<GatewayContextApiGroups, HttpApiGroup.Constraint>
>;

export interface GatewayContextClientOptions {
  readonly baseUrl?: string | URL;
  readonly cookie?: string;
}

export type GatewayContextClientError =
  | GatewayContextProblem
  | HttpClientError.HttpClientError
  | Schema.SchemaError;

export type GatewayContextClientEffect<Success> = Effect.Effect<Success, GatewayContextClientError>;

const GatewayContextRequestOptions = Context.Reference<GatewayContextClientOptions>(
  'GatewayContextRequestOptions',
  { defaultValue: () => ({}) },
);

const gatewayContextClient = makeEffectHttpApiClient(GatewayContextApi, {
  transformClient: HttpClient.mapRequestEffect((request) =>
    GatewayContextRequestOptions.pipe(
      Effect.map((options) => {
        let nextRequest = HttpClientRequest.prependUrl(
          request,
          (options.baseUrl ?? shellGatewayContextContract.apiPrefix).toString(),
        );
        if (options.cookie !== undefined) {
          nextRequest = HttpClientRequest.setHeader(nextRequest, 'cookie', options.cookie);
        }
        return nextRequest;
      }),
    ),
  ),
});

const invokeGatewayContextClient = <Success, Failure>(
  options: GatewayContextClientOptions,
  operation: (client: GatewayContextClient) => Effect.Effect<Success, Failure>,
): Effect.Effect<Success, Failure> =>
  gatewayContextClient.pipe(
    Effect.flatMap(operation),
    Effect.provideService(GatewayContextRequestOptions, options),
  );

export const issueGatewayContext = (
  payload: GatewayContextRequest,
  options: GatewayContextClientOptions = {},
): GatewayContextClientEffect<GatewayContextResponse> =>
  Schema.decodeUnknownEffect(GatewayContextRequestSchema)(payload).pipe(
    Effect.flatMap((decodedPayload) =>
      invokeGatewayContextClient(options, (client) =>
        client.gatewayContext.issueGatewayContext({ payload: decodedPayload }),
      ),
    ),
  );
