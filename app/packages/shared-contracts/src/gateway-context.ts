import { TrustedPrincipalContextSchema } from '@app/core-runtime/actions/principal-context';
import type { TrustedPrincipalContext } from '@app/core-runtime/actions/principal-context';
import {
  Effect,
  HttpApi,
  HttpApiEndpoint,
  HttpApiGroup,
  HttpApiSchema,
  Schema,
  makeEffectHttpApiClient,
} from '@modern-js/bff-effect/effect-client';
import type { HttpClientError } from '@modern-js/bff-effect/effect-client';
import { Context } from 'effect';
import { HttpClient, HttpClientRequest } from 'effect/unstable/http';

import { problemDetailsContentType, problemDetailsFields } from './problem-details.ts';

export const GATEWAY_ASSERTION_VERSION = 1 as const;
export const EXTERNAL_GATEWAY_ASSERTION_VERSION = 2 as const;
export const GATEWAY_ASSERTION_TTL_SECONDS = 300 as const;
export const GATEWAY_ASSERTION_CLOCK_SKEW_SECONDS = 30 as const;

const nonEmptyString = Schema.String.check(Schema.isMinLength(1));
const uuid = Schema.String.check(Schema.isUUID());
const LegalEntityIdSchema = uuid.pipe(Schema.brand('LegalEntityId'));
const epochSeconds = Schema.Finite.check(Schema.isInt(), Schema.isGreaterThanOrEqualTo(0));
const compositionRevision = Schema.String.check(Schema.isPattern(/^[\da-f]{64}$/u));
const targetBuildMarker = nonEmptyString.check(Schema.isMaxLength(200), Schema.isTrimmed());
export const GatewayAudienceSchema = nonEmptyString.check(
  Schema.makeFilter((value) =>
    /^[a-z][a-z0-9]*(?:[.-][a-z0-9]+)*$/u.test(value) ? undefined : 'audience must be a stable topology app ID',
  ),
);

export const GatewayTrustedPrincipalContextSchema = TrustedPrincipalContextSchema;

export type GatewayTrustedPrincipalContext = TrustedPrincipalContext;

export const GatewayContextProtectedHeaderSchema = Schema.Struct({
  alg: Schema.Literal('EdDSA'),
  kid: nonEmptyString,
  typ: Schema.Literal('JWT'),
});

export type GatewayContextProtectedHeader = Schema.Schema.Type<typeof GatewayContextProtectedHeaderSchema>;

export const GatewayContextClaimsSchema = Schema.Struct({
  aud: GatewayAudienceSchema,
  compositionRevision,
  exp: epochSeconds,
  iat: epochSeconds,
  iss: nonEmptyString,
  jti: uuid,
  principal: GatewayTrustedPrincipalContextSchema,
  sub: uuid,
  targetBuildMarker,
  ver: Schema.Literal(GATEWAY_ASSERTION_VERSION),
}).check(
  Schema.makeFilter((claims) => {
    const issues: Schema.FilterIssue[] = [];
    if (claims.exp <= claims.iat) {
      issues.push({ issue: 'exp must be greater than iat', path: ['exp'] });
    }
    if (claims.exp - claims.iat !== GATEWAY_ASSERTION_TTL_SECONDS) {
      issues.push({
        issue: 'exp must be exactly 300 seconds after iat',
        path: ['exp'],
      });
    }
    if (claims.sub !== claims.principal.principalId) {
      issues.push({
        issue: 'sub must equal principal.principalId',
        path: ['sub'],
      });
    }
    if (claims.principal.authenticationNamespaceId !== undefined) {
      issues.push({ issue: 'version 1 cannot carry external identity evidence', path: ['principal'] });
    }
    return issues;
  }),
);

/** Version 2 retains the signing and lifetime contract; admission remains a receiving-runtime duty. */
export const GatewayContextV2ClaimsSchema = Schema.Struct({
  aud: GatewayAudienceSchema,
  compositionRevision,
  exp: epochSeconds,
  iat: epochSeconds,
  iss: nonEmptyString,
  jti: uuid,
  principal: GatewayTrustedPrincipalContextSchema,
  sub: uuid,
  targetBuildMarker,
  ver: Schema.Literal(EXTERNAL_GATEWAY_ASSERTION_VERSION),
}).check(
  Schema.makeFilter((claims) => [
    ...(claims.exp - claims.iat === GATEWAY_ASSERTION_TTL_SECONDS
      ? []
      : [{ issue: 'exp must be exactly 300 seconds after iat', path: ['exp'] }]),
    ...(claims.sub === claims.principal.principalId
      ? []
      : [{ issue: 'sub must equal principal.principalId', path: ['sub'] }]),
    ...(claims.principal.authenticationNamespaceId === undefined
      ? [{ issue: 'version 2 requires an explicit authentication namespace', path: ['principal'] }]
      : []),
  ]),
);
export type GatewayContextV2Claims = typeof GatewayContextV2ClaimsSchema.Type;
export const SupportedGatewayContextClaimsSchema = Schema.Union([
  GatewayContextClaimsSchema,
  GatewayContextV2ClaimsSchema,
]);
export type SupportedGatewayContextClaims = typeof SupportedGatewayContextClaimsSchema.Type;
export const decodeSupportedGatewayContextClaims = Schema.decodeUnknownEffect(SupportedGatewayContextClaimsSchema, {
  onExcessProperty: 'error',
});

export type GatewayContextClaims = Schema.Schema.Type<typeof GatewayContextClaimsSchema>;

export const decodeGatewayContextClaims = Schema.decodeUnknownEffect(GatewayContextClaimsSchema, {
  onExcessProperty: 'error',
});

export const decodeGatewayContextProtectedHeader = Schema.decodeUnknownEffect(GatewayContextProtectedHeaderSchema, {
  onExcessProperty: 'error',
});

export const GatewayContextRequestSchema = Schema.Struct({
  audience: GatewayAudienceSchema,
  compositionRevision,
  legalEntityId: Schema.optionalKey(LegalEntityIdSchema),
});
export type GatewayContextRequest = typeof GatewayContextRequestSchema.Encoded;

export const GatewayContextResponseSchema = Schema.Struct({
  apiBaseUrl: Schema.String.check(
    Schema.isMinLength(1),
    Schema.isMaxLength(1000),
    Schema.isPattern(/^\/(?!\/)[A-Za-z0-9._~!$&'()*+,;=:@%/-]+$/u),
  ),
  compositionRevision,
  expiresAt: epochSeconds,
  token: nonEmptyString,
});
export type GatewayContextResponse = Schema.Schema.Type<typeof GatewayContextResponseSchema>;

export const GatewayAuthenticationRequiredProblemSchema = Schema.TaggedStruct('GatewayAuthenticationRequiredProblem', {
  ...problemDetailsFields,
  status: Schema.Literal(401),
}).pipe(HttpApiSchema.asJson({ contentType: problemDetailsContentType }), HttpApiSchema.status(401));

export const GatewayAudienceInvalidProblemSchema = Schema.TaggedStruct('GatewayAudienceInvalidProblem', {
  ...problemDetailsFields,
  status: Schema.Literal(400),
}).pipe(HttpApiSchema.asJson({ contentType: problemDetailsContentType }), HttpApiSchema.status(400));

export const GatewayReloadRequiredProblemSchema = Schema.TaggedStruct('GatewayReloadRequiredProblem', {
  ...problemDetailsFields,
  reloadRequired: Schema.Literal(true),
  status: Schema.Literal(409),
}).pipe(HttpApiSchema.asJson({ contentType: problemDetailsContentType }), HttpApiSchema.status(409));

export const GatewayUnavailableProblemSchema = Schema.TaggedStruct('GatewayUnavailableProblem', {
  ...problemDetailsFields,
  retryable: Schema.Literal(true),
  status: Schema.Literal(503),
}).pipe(HttpApiSchema.asJson({ contentType: problemDetailsContentType }), HttpApiSchema.status(503));

export const GatewayInternalProblemSchema = Schema.TaggedStruct('GatewayInternalProblem', {
  ...problemDetailsFields,
  status: Schema.Literal(500),
}).pipe(HttpApiSchema.asJson({ contentType: problemDetailsContentType }), HttpApiSchema.status(500));
export const GatewayForbiddenProblemSchema = Schema.TaggedStruct('GatewayForbiddenProblem', {
  ...problemDetailsFields,
  status: Schema.Literal(403),
}).pipe(HttpApiSchema.asJson({ contentType: problemDetailsContentType }), HttpApiSchema.status(403));
export const GatewayRateLimitedProblemSchema = Schema.TaggedStruct('GatewayRateLimitedProblem', {
  ...problemDetailsFields,
  retryAfterSeconds: Schema.Finite,
  status: Schema.Literal(429),
}).pipe(HttpApiSchema.asJson({ contentType: problemDetailsContentType }), HttpApiSchema.status(429));

export type GatewayAuthenticationRequiredProblem = Schema.Schema.Type<
  typeof GatewayAuthenticationRequiredProblemSchema
>;
export type GatewayAudienceInvalidProblem = Schema.Schema.Type<typeof GatewayAudienceInvalidProblemSchema>;
export type GatewayReloadRequiredProblem = Schema.Schema.Type<typeof GatewayReloadRequiredProblemSchema>;
export type GatewayUnavailableProblem = Schema.Schema.Type<typeof GatewayUnavailableProblemSchema>;
export type GatewayInternalProblem = Schema.Schema.Type<typeof GatewayInternalProblemSchema>;
type GatewayForbiddenProblem = Schema.Schema.Type<typeof GatewayForbiddenProblemSchema>;
type GatewayRateLimitedProblem = Schema.Schema.Type<typeof GatewayRateLimitedProblemSchema>;

export type GatewayContextProblem =
  | GatewayAuthenticationRequiredProblem
  | GatewayAudienceInvalidProblem
  | GatewayReloadRequiredProblem
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
        GatewayReloadRequiredProblemSchema,
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
        GatewayReloadRequiredProblemSchema,
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

export interface GatewayContextClientOptions {
  readonly baseUrl?: string | URL;
  readonly cookie?: string;
}

export type GatewayContextClientError = GatewayContextProblem | HttpClientError.HttpClientError | Schema.SchemaError;

export type GatewayContextClientEffect<Success> = Effect.Effect<Success, GatewayContextClientError>;

const GatewayContextRequestOptions = Context.Reference<GatewayContextClientOptions>('GatewayContextRequestOptions', {
  defaultValue: () => ({}),
});

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

export const issueGatewayContext = (
  payload: GatewayContextRequest,
  options: GatewayContextClientOptions = {},
): GatewayContextClientEffect<GatewayContextResponse> =>
  Schema.decodeEffect(GatewayContextRequestSchema)(payload).pipe(
    Effect.flatMap((decodedPayload) =>
      gatewayContextClient.pipe(
        Effect.flatMap((client) => client.gatewayContext.issueGatewayContext({ payload: decodedPayload })),
      ),
    ),
    Effect.provideService(GatewayContextRequestOptions, options),
  );
