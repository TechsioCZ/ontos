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
import { HttpClient, HttpClientRequest } from 'effect/http';
import { BadRequestNoContent } from 'effect/http-api/HttpApiError';

import { problemDetailsContentType, problemDetailsFields } from './problem-details.ts';

export const GATEWAY_ASSERTION_VERSION = 1 as const;
export const EXTERNAL_GATEWAY_ASSERTION_VERSION = 2 as const;
export const DELEGATED_GATEWAY_ASSERTION_VERSION = 3 as const;
export const GATEWAY_ASSERTION_TTL_SECONDS = 300 as const;
export const GATEWAY_ASSERTION_CLOCK_SKEW_SECONDS = 30 as const;

const nonEmptyString = Schema.String.check(Schema.isMinLength(1));
const uuid = Schema.String.check(Schema.isUUID());
const LegalEntityIdSchema = uuid.pipe(Schema.brand('LegalEntityId'));
const epochSeconds = Schema.Finite.check(Schema.isInt(), Schema.isGreaterThanOrEqualTo(0));
const compositionRevision = Schema.String.check(Schema.isPattern(/^[\da-f]{64}$/u));
const targetBuildMarker = nonEmptyString.check(Schema.isMaxLength(200), Schema.isTrimmed());
const PrincipalIdSchema = uuid.pipe(Schema.brand('PrincipalId'));
const TenantIdSchema = uuid.pipe(Schema.brand('TenantId'));
const ActionInvocationIdSchema = uuid.pipe(Schema.brand('ActionInvocationId'));
const EXACT_LIFETIME_ISSUE = 'exp must be exactly 300 seconds after iat';
const SUBJECT_IS_PRINCIPAL_ISSUE = 'sub must equal principal.principalId';
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
        issue: EXACT_LIFETIME_ISSUE,
        path: ['exp'],
      });
    }
    if (claims.sub !== claims.principal.principalId) {
      issues.push({
        issue: SUBJECT_IS_PRINCIPAL_ISSUE,
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
      : [{ issue: EXACT_LIFETIME_ISSUE, path: ['exp'] }]),
    ...(claims.sub === claims.principal.principalId ? [] : [{ issue: SUBJECT_IS_PRINCIPAL_ISSUE, path: ['sub'] }]),
    ...(claims.principal.authenticationNamespaceId === undefined
      ? [{ issue: 'version 2 requires an explicit authentication namespace', path: ['principal'] }]
      : []),
  ]),
);
export type GatewayContextV2Claims = typeof GatewayContextV2ClaimsSchema.Type;

/** The calling module that presented the delegated request; only Shell signs this claim. */
export const GatewayActorClaimSchema = Schema.Struct({
  appId: GatewayAudienceSchema.pipe(Schema.brand('AppId')),
  buildMarker: targetBuildMarker,
  principalId: PrincipalIdSchema,
});
export type GatewayActorClaim = typeof GatewayActorClaimSchema.Type;

/** Version 3 names the subject in `sub`/`principal` and the calling module in `act`. */
export const GatewayContextV3ClaimsSchema = Schema.Struct({
  act: GatewayActorClaimSchema,
  aud: GatewayAudienceSchema,
  compositionRevision,
  exp: epochSeconds,
  iat: epochSeconds,
  iss: nonEmptyString,
  jti: uuid,
  principal: GatewayTrustedPrincipalContextSchema,
  sub: uuid,
  targetBuildMarker,
  ver: Schema.Literal(DELEGATED_GATEWAY_ASSERTION_VERSION),
}).check(
  Schema.makeFilter((claims) => [
    ...(claims.exp - claims.iat === GATEWAY_ASSERTION_TTL_SECONDS
      ? []
      : [{ issue: EXACT_LIFETIME_ISSUE, path: ['exp'] }]),
    ...(claims.sub === claims.principal.principalId ? [] : [{ issue: SUBJECT_IS_PRINCIPAL_ISSUE, path: ['sub'] }]),
    ...(claims.principal.authenticationNamespaceId === undefined
      ? [{ issue: 'version 3 requires an explicit authentication namespace', path: ['principal'] }]
      : []),
    ...(claims.act.principalId === claims.sub
      ? [{ issue: 'act.principalId must differ from sub', path: ['act', 'principalId'] }]
      : []),
  ]),
);
export type GatewayContextV3Claims = typeof GatewayContextV3ClaimsSchema.Type;

export const SupportedGatewayContextClaimsSchema = Schema.Union([
  GatewayContextClaimsSchema,
  GatewayContextV2ClaimsSchema,
  GatewayContextV3ClaimsSchema,
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

/** Server credentials may bind to the active release without first downloading its composition. */
export const ApiKeyGatewayContextRequestSchema = Schema.Struct({
  ...GatewayContextRequestSchema.fields,
  compositionRevision: Schema.optionalKey(compositionRevision),
});
export type ApiKeyGatewayContextRequest = typeof ApiKeyGatewayContextRequestSchema.Encoded;

/**
 * Whole HTTP JSON body for the credential-authenticated owner proxy. Typed clients send bytes, not a
 * shared owner DTO. Shell decodes routing metadata privately; the receiving owner validates its query.
 */
export const ApiKeyGatewayReadRequestSchema = Schema.Uint8Array.pipe(
  HttpApiSchema.asUint8Array({ contentType: 'application/json' }),
);

/** Owner response bytes, without a shared JSON wrapper or a second JSON serialization. */
const ApiKeyGatewayReadResponseSchema = Schema.Uint8Array.pipe(
  HttpApiSchema.asUint8Array({ contentType: 'application/json' }),
);

/** Server-only response metadata; never exposed through CORS or persisted by an intermediary. */
export const API_KEY_GATEWAY_CONTEXT_HEADER = 'x-ontos-gateway-context';

/**
 * Whom a module call is done for. `Assertion` carries the verified incoming token of a live request;
 * `Originator` names the action invocation of asynchronous work whose requester the call acts for, and may
 * name the one company that work belongs to when the invocation itself ran in the tenant context. The Shell
 * admits that company only for a workload requester bound in the tenant; a person keeps the company the
 * invocation recorded.
 */
export const GatewayDelegatedSubjectSchema = Schema.Union([
  Schema.TaggedStruct('Assertion', {
    sourceAssertion: Schema.RedactedFromValue(nonEmptyString),
  }),
  Schema.TaggedStruct('Originator', {
    actionInvocationId: ActionInvocationIdSchema,
    legalEntityId: Schema.optionalKey(LegalEntityIdSchema),
    tenantId: TenantIdSchema,
  }),
]);
export type GatewayDelegatedSubject = typeof GatewayDelegatedSubjectSchema.Encoded;

/** A module-to-module capability request; the calling module authenticates with its own key. */
export const GatewayDelegatedContextRequestSchema = Schema.Struct({
  audience: GatewayAudienceSchema,
  compositionRevision,
  exchangeId: uuid.pipe(Schema.brand('GatewayDelegationExchangeId')),
  /**
   * The company scope the caller states. `subject` carries the subject's Legal Entity, or none when the subject has
   * none; `tenant` carries no Legal Entity.
   */
  legalEntityScope: Schema.Literals(['subject', 'tenant']),
  subject: GatewayDelegatedSubjectSchema,
});
export type GatewayDelegatedContextRequest = typeof GatewayDelegatedContextRequestSchema.Encoded;

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

/**
 * Why the Shell refused to issue a gateway context, as a stable code a caller logs and an operator searches for. It
 * names the failing step only: never a key, a token, a subject or anything the caller did not already send.
 */
export const GatewayRefusalReasonSchema = Schema.Literals([
  // The caller and its key.
  'key_provider_unavailable',
  'key_state_inconsistent',
  'module_enrolment_unavailable',
  'module_credential_unbound',
  'module_credential_not_admitted',
  'caller_principal_unavailable',
  'caller_principal_unresolved',
  'caller_not_service',
  'caller_build_not_installed',
  // The release.
  'installed_release_unavailable',
  'release_changed',
  'audience_not_installed',
  // The subject the context is for.
  'verification_keys_unavailable',
  'subject_assertion_unverified',
  'subject_assertion_malformed',
  'subject_assertion_not_attested',
  'subject_verification_timeout',
  'subject_authentication_unavailable',
  'subject_authentication_ended',
  'originator_evidence_unavailable',
  'originator_not_admitted',
  'subject_not_delegable',
  // The scope, the modules and the issuance.
  'scope_unavailable',
  'scope_refused',
  'module_states_unavailable',
  'module_not_active',
  // The module the call is for is absent for the subject's tenant, switched off (`inactive`) or retired with it
  // (`archived`): lasting states, the only refusal a caller may read as "not installed" (403 with
  // GATEWAY_MODULE_NOT_INSTALLED_TYPE).
  'audience_module_not_installed',
  // It is stopped for now (`suspended`, `quarantined`): a plain refusal, never "not installed", so a caller treats it
  // as an outage, not as an answer.
  'audience_module_not_active',
  'exchange_ledger_unavailable',
  'exchange_replayed',
  'issuer_unavailable',
]);
export type GatewayRefusalReason = typeof GatewayRefusalReasonSchema.Type;
const refusalReason = { reason: Schema.optionalKey(GatewayRefusalReasonSchema) };

export const GatewayAuthenticationRequiredProblemSchema = Schema.TaggedStruct('GatewayAuthenticationRequiredProblem', {
  ...problemDetailsFields,
  ...refusalReason,
  status: Schema.Literal(401),
}).pipe(HttpApiSchema.asJson({ contentType: problemDetailsContentType }), HttpApiSchema.status(401));

export const GatewayAudienceInvalidProblemSchema = Schema.TaggedStruct('GatewayAudienceInvalidProblem', {
  ...problemDetailsFields,
  status: Schema.Literal(400),
}).pipe(HttpApiSchema.asJson({ contentType: problemDetailsContentType }), HttpApiSchema.status(400));

export const GatewayReloadRequiredProblemSchema = Schema.TaggedStruct('GatewayReloadRequiredProblem', {
  ...problemDetailsFields,
  ...refusalReason,
  reloadRequired: Schema.Literal(true),
  status: Schema.Literal(409),
}).pipe(HttpApiSchema.asJson({ contentType: problemDetailsContentType }), HttpApiSchema.status(409));

export const GatewayUnavailableProblemSchema = Schema.TaggedStruct('GatewayUnavailableProblem', {
  ...problemDetailsFields,
  ...refusalReason,
  retryable: Schema.Literal(true),
  status: Schema.Literal(503),
}).pipe(HttpApiSchema.asJson({ contentType: problemDetailsContentType }), HttpApiSchema.status(503));

export const GatewayInternalProblemSchema = Schema.TaggedStruct('GatewayInternalProblem', {
  ...problemDetailsFields,
  status: Schema.Literal(500),
}).pipe(HttpApiSchema.asJson({ contentType: problemDetailsContentType }), HttpApiSchema.status(500));
/**
 * The `type` of the 403 a delegated module call gets when the module it calls is not installed for the subject's
 * tenant: absent there, switched off (`inactive`) or retired with the tenant (`archived`). Every other refusal of the
 * call, a module suspended or quarantined for now included, is a plain `GatewayForbiddenProblem`.
 */
export const GATEWAY_MODULE_NOT_INSTALLED_TYPE = 'https://ontos.dev/problems/gateway-module-not-installed';

export const GatewayForbiddenProblemSchema = Schema.TaggedStruct('GatewayForbiddenProblem', {
  ...problemDetailsFields,
  ...refusalReason,
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
      payload: ApiKeyGatewayContextRequestSchema,
      success: GatewayContextResponseSchema,
    }),
  )
  .add(
    HttpApiEndpoint.post('readWithApiKeyGatewayContext', '/auth/api-key/gateway-read', {
      error: [
        BadRequestNoContent,
        GatewayAuthenticationRequiredProblemSchema,
        GatewayAudienceInvalidProblemSchema,
        GatewayReloadRequiredProblemSchema,
        GatewayForbiddenProblemSchema,
        GatewayRateLimitedProblemSchema,
        GatewayUnavailableProblemSchema,
        GatewayInternalProblemSchema,
      ],
      headers: ApiKeyGatewayHeadersSchema,
      payload: ApiKeyGatewayReadRequestSchema,
      success: ApiKeyGatewayReadResponseSchema,
    }),
  )
  .add(
    HttpApiEndpoint.post('issueDelegatedGatewayContext', '/auth/delegated/gateway-context', {
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
      payload: GatewayDelegatedContextRequestSchema,
      success: GatewayContextResponseSchema,
    }),
  );

export const GatewayContextApi = HttpApi.make('shellGatewayContextApi').add(GatewayContextApiGroup);

export const shellGatewayContextContract = {
  apiPrefix: '/shell-super-app-api',
  documentContextPath: '/shell-super-app-api/shell/document-context',
  issueApiKeyGatewayContextPath: '/shell-super-app-api/auth/api-key/gateway-context',
  issueDelegatedGatewayContextPath: '/shell-super-app-api/auth/delegated/gateway-context',
  issueDocumentGatewayContextsPath: '/shell-super-app-api/auth/gateway-contexts',
  issueGatewayContextPath: '/shell-super-app-api/auth/gateway-context',
  ownerId: 'shell-super-app',
  readWithApiKeyGatewayContextPath: '/shell-super-app-api/auth/api-key/gateway-read',
} as const;

export const gatewayContextAuthorizationEntrypoints = [
  {
    authorization: { credential: 'api_key', kind: 'capability_issuance' },
    deployment: shellGatewayContextContract.ownerId,
    entrypointKey: 'shell.gateway-context.issue.delegated',
    owner: shellGatewayContextContract.ownerId,
    path: shellGatewayContextContract.issueDelegatedGatewayContextPath,
    surface: 'capability_issuance',
  },
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
  {
    authorization: { credential: 'api_key', kind: 'capability_issuance' },
    deployment: shellGatewayContextContract.ownerId,
    entrypointKey: 'shell.gateway-read.issue.api-key',
    owner: shellGatewayContextContract.ownerId,
    path: shellGatewayContextContract.readWithApiKeyGatewayContextPath,
    surface: 'capability_issuance',
  },
  {
    authorization: { credential: 'session', kind: 'capability_issuance' },
    deployment: shellGatewayContextContract.ownerId,
    entrypointKey: 'shell.gateway-contexts.issue.session',
    owner: shellGatewayContextContract.ownerId,
    path: shellGatewayContextContract.issueDocumentGatewayContextsPath,
    surface: 'capability_issuance',
  },
  // Server rendering's one context read also signs the document's assertions, so they need no second invocation.
  {
    authorization: { credential: 'session', kind: 'capability_issuance' },
    deployment: shellGatewayContextContract.ownerId,
    entrypointKey: 'shell.document-context.issue.session',
    owner: shellGatewayContextContract.ownerId,
    path: shellGatewayContextContract.documentContextPath,
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
