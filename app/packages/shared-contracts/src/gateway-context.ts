import {
  Effect,
  HttpApi,
  HttpApiEndpoint,
  HttpApiGroup,
  HttpApiSchema,
  Schema,
  makeEffectHttpApiClient,
} from '@modern-js/plugin-bff/effect-client';
import type { HttpApiClient, HttpClientError } from '@modern-js/plugin-bff/effect-client';
import { TrustedPrincipalContextSchema } from '@app/core-runtime/actions/principal-context';
import type { TrustedPrincipalContext } from '@app/core-runtime/actions/principal-context';
import { HttpClient, HttpClientRequest } from 'effect/unstable/http';

export const GATEWAY_ASSERTION_VERSION = 1 as const;
export const GATEWAY_ASSERTION_TTL_SECONDS = 300 as const;
export const GATEWAY_ASSERTION_CLOCK_SKEW_SECONDS = 30 as const;

const nonEmptyString = Schema.String.check(Schema.isMinLength(1));
const uuid = Schema.String.check(Schema.isUUID());
const epochSeconds = Schema.Finite.check(Schema.isInt(), Schema.isGreaterThanOrEqualTo(0));
const gatewayAudience = nonEmptyString.check(
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
  aud: gatewayAudience,
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
  audience: gatewayAudience,
  legalEntityId: Schema.optionalKey(uuid),
});
export type GatewayContextRequest = Schema.Schema.Type<typeof GatewayContextRequestSchema>;

export const GatewayContextResponseSchema = Schema.Struct({
  expiresAt: epochSeconds,
  token: nonEmptyString,
});
export type GatewayContextResponse = Schema.Schema.Type<typeof GatewayContextResponseSchema>;

interface ProblemDetails {
  readonly detail: string;
  readonly status: number;
  readonly title: string;
  readonly type: string;
}

export interface GatewayAuthenticationRequiredProblem extends ProblemDetails {
  readonly _tag: 'GatewayAuthenticationRequiredProblem';
}

export interface GatewayAudienceInvalidProblem extends ProblemDetails {
  readonly _tag: 'GatewayAudienceInvalidProblem';
}

export interface GatewayUnavailableProblem extends ProblemDetails {
  readonly _tag: 'GatewayUnavailableProblem';
  readonly retryable: true;
}

export interface GatewayInternalProblem extends ProblemDetails {
  readonly _tag: 'GatewayInternalProblem';
}
export interface GatewayForbiddenProblem extends ProblemDetails {
  readonly _tag: 'GatewayForbiddenProblem';
}
export interface GatewayRateLimitedProblem extends ProblemDetails {
  readonly _tag: 'GatewayRateLimitedProblem';
  readonly retryAfterSeconds: number;
}

export type GatewayContextProblem =
  | GatewayAuthenticationRequiredProblem
  | GatewayAudienceInvalidProblem
  | GatewayForbiddenProblem
  | GatewayRateLimitedProblem
  | GatewayUnavailableProblem
  | GatewayInternalProblem;

const problemDetailsFields = {
  detail: Schema.String,
  status: Schema.Finite,
  title: Schema.String,
  type: Schema.String,
};
const asProblemDetails = HttpApiSchema.asJson({ contentType: 'application/problem+json' });

export const GatewayAuthenticationRequiredProblemSchema = Schema.TaggedStruct(
  'GatewayAuthenticationRequiredProblem',
  problemDetailsFields,
).pipe(asProblemDetails, HttpApiSchema.status(401));

export const GatewayAudienceInvalidProblemSchema = Schema.TaggedStruct(
  'GatewayAudienceInvalidProblem',
  problemDetailsFields,
).pipe(asProblemDetails, HttpApiSchema.status(400));

export const GatewayUnavailableProblemSchema = Schema.TaggedStruct('GatewayUnavailableProblem', {
  ...problemDetailsFields,
  retryable: Schema.Literal(true),
}).pipe(asProblemDetails, HttpApiSchema.status(503));

export const GatewayInternalProblemSchema = Schema.TaggedStruct(
  'GatewayInternalProblem',
  problemDetailsFields,
).pipe(asProblemDetails, HttpApiSchema.status(500));
export const GatewayForbiddenProblemSchema = Schema.TaggedStruct(
  'GatewayForbiddenProblem',
  problemDetailsFields,
).pipe(asProblemDetails, HttpApiSchema.status(403));
export const GatewayRateLimitedProblemSchema = Schema.TaggedStruct('GatewayRateLimitedProblem', {
  ...problemDetailsFields,
  retryAfterSeconds: Schema.Finite,
}).pipe(asProblemDetails, HttpApiSchema.status(429));

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

type GatewayContextApiGroups =
  typeof GatewayContextApi extends HttpApi.HttpApi<infer _ApiId, infer Groups> ? Groups : never;

export type GatewayContextClient = HttpApiClient.Client<
  Extract<GatewayContextApiGroups, HttpApiGroup.Any>,
  never,
  never
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

const createGatewayContextClient = (
  options: GatewayContextClientOptions,
): Effect.Effect<GatewayContextClient> => {
  const transformClient =
    options.cookie === undefined
      ? {}
      : {
          transformClient: HttpClient.mapRequest(
            HttpClientRequest.setHeader('cookie', options.cookie),
          ),
        };

  return makeEffectHttpApiClient(GatewayContextApi, {
    baseUrl: options.baseUrl ?? shellGatewayContextContract.apiPrefix,
    ...transformClient,
  });
};

export const issueGatewayContext = (
  payload: GatewayContextRequest,
  options: GatewayContextClientOptions = {},
): GatewayContextClientEffect<GatewayContextResponse> =>
  createGatewayContextClient(options).pipe(
    Effect.flatMap((client) => client.gatewayContext.issueGatewayContext({ payload })),
  );

export const issueApiKeyGatewayContext = (
  rawKey: string,
  payload: GatewayContextRequest,
  options: Omit<GatewayContextClientOptions, 'cookie'> = {},
): GatewayContextClientEffect<GatewayContextResponse> =>
  createGatewayContextClient(options).pipe(
    Effect.flatMap((client) =>
      client.gatewayContext.issueApiKeyGatewayContext({
        headers: { 'x-api-key': rawKey },
        payload,
      }),
    ),
  );
