import {
  RegisteredGatewayRecoverySchema,
  RegisteredGatewayRouteScopeSchema,
  RegisteredGatewayWorkloadSchema,
  RegisteredGatewayPrivacyDispatchSchema,
  privacyDispatchOperationContract,
  RegisteredGatewayOrganizationGovernanceReadSchema,
  organizationGovernanceReadOperationContract,
} from '@app/core-runtime/auth/system-principal-context-provenance';
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

import { problemDetailsContentType, problemDetailsFields } from './problem-details.ts';

export const GATEWAY_ASSERTION_VERSION = 1 as const;
export const EXTERNAL_GATEWAY_ASSERTION_VERSION = 2 as const;
export const DELEGATED_GATEWAY_ASSERTION_VERSION = 3 as const;
export const WORKLOAD_GATEWAY_ASSERTION_VERSION = 4 as const;
export const PRIVACY_DISPATCH_GATEWAY_ASSERTION_VERSION = 5 as const;
export const ORGANIZATION_GOVERNANCE_GATEWAY_ASSERTION_VERSION = 6 as const;
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
export const GatewayCapabilityKeySchema = nonEmptyString.pipe(
  Schema.brand('GatewayCapabilityKey'),
  Schema.decodeTo(Schema.String),
);
export const GatewaySourceActionKeySchema = nonEmptyString.pipe(
  Schema.brand('GatewaySourceActionKey'),
  Schema.decodeTo(Schema.String),
);
const GatewayClaimIdSchema = nonEmptyString.pipe(Schema.brand('GatewayClaimId'), Schema.decodeTo(Schema.String));
const GatewayDeliveryIdSchema = uuid.pipe(Schema.brand('GatewayDeliveryId'), Schema.decodeTo(Schema.String));
const GatewayWorkerKeySchema = nonEmptyString.pipe(Schema.brand('GatewayWorkerKey'), Schema.decodeTo(Schema.String));
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
  routeScope: Schema.optionalKey(RegisteredGatewayRouteScopeSchema),
  sub: uuid,
  targetBuildMarker,
  ver: Schema.Literal(EXTERNAL_GATEWAY_ASSERTION_VERSION),
}).check(
  Schema.makeFilter((claims) => [
    ...(claims.exp - claims.iat === GATEWAY_ASSERTION_TTL_SECONDS
      ? []
      : [{ issue: EXACT_LIFETIME_ISSUE, path: ['exp'] }]),
    ...(claims.sub === claims.principal.principalId ? [] : [{ issue: SUBJECT_IS_PRINCIPAL_ISSUE, path: ['sub'] }]),
    ...(claims.routeScope === undefined ||
    (claims.principal.authMethod === 'api_key' &&
      claims.principal.principalId === claims.routeScope.principalId &&
      claims.principal.tenantId === claims.routeScope.tenantId &&
      claims.principal.legalEntityId === claims.routeScope.legalEntityId)
      ? []
      : [{ issue: 'A route scope requires its exact API-key principal, tenant, and company', path: ['routeScope'] }]),
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

/** A tenant-local registered system workload, restricted to one owner capability and binding incarnation. */
export const GatewayContextV4ClaimsSchema = Schema.Struct({
  aud: GatewayAudienceSchema,
  compositionRevision,
  exp: epochSeconds,
  iat: epochSeconds,
  iss: nonEmptyString,
  jti: uuid,
  principal: GatewayTrustedPrincipalContextSchema,
  sub: uuid,
  targetBuildMarker,
  ver: Schema.Literal(WORKLOAD_GATEWAY_ASSERTION_VERSION),
  workload: RegisteredGatewayWorkloadSchema,
}).check(
  Schema.makeFilter((claims) => [
    ...(claims.exp - claims.iat === GATEWAY_ASSERTION_TTL_SECONDS
      ? []
      : [{ issue: EXACT_LIFETIME_ISSUE, path: ['exp'] }]),
    ...(claims.sub === claims.principal.principalId ? [] : [{ issue: SUBJECT_IS_PRINCIPAL_ISSUE, path: ['sub'] }]),
    ...(claims.principal.authMethod === 'system' &&
    claims.principal.authContextRef === `job:${claims.workload.jobKey}:run:${claims.workload.runReference}`
      ? []
      : [{ issue: 'version 4 requires the registered delivery system context', path: ['principal'] }]),
  ]),
);

/** Finite native Privacy dispatch authority retains its original human and governance company. */
export const GatewayContextV5ClaimsSchema = Schema.Struct({
  act: GatewayActorClaimSchema,
  aud: GatewayAudienceSchema,
  compositionRevision,
  exp: epochSeconds,
  iat: epochSeconds,
  iss: nonEmptyString,
  jti: uuid,
  principal: GatewayTrustedPrincipalContextSchema,
  privacyDispatch: RegisteredGatewayPrivacyDispatchSchema,
  sub: uuid,
  targetBuildMarker,
  ver: Schema.Literal(PRIVACY_DISPATCH_GATEWAY_ASSERTION_VERSION),
}).check(
  Schema.makeFilter((claims) => [
    ...(claims.exp - claims.iat === GATEWAY_ASSERTION_TTL_SECONDS
      ? []
      : [{ issue: EXACT_LIFETIME_ISSUE, path: ['exp'] }]),
    ...(claims.sub === claims.principal.principalId ? [] : [{ issue: SUBJECT_IS_PRINCIPAL_ISSUE, path: ['sub'] }]),
    ...((claims.principal.authMethod === 'session' || claims.principal.authMethod === 'api_key') &&
    claims.principal.impersonatedByPrincipalId === undefined &&
    claims.principal.principalId === claims.privacyDispatch.principalId &&
    claims.principal.tenantId === claims.privacyDispatch.tenantId &&
    claims.principal.legalEntityId === claims.privacyDispatch.governanceLegalEntityId
      ? []
      : [{ issue: 'Version 5 requires the exact original human and governance company', path: ['principal'] }]),
    ...(claims.act.principalId === claims.sub
      ? [{ issue: 'act.principalId must differ from sub', path: ['act', 'principalId'] }]
      : []),
    ...(claims.aud === privacyDispatchOperationContract(claims.privacyDispatch.operation).appId
      ? []
      : [{ issue: 'The finite Privacy dispatch operation requires its exact audience', path: ['aud'] }]),
  ]),
);
export type GatewayContextV5Claims = typeof GatewayContextV5ClaimsSchema.Type;

/** One governed organization source-facts Read under the original live human Privacy context. */
export const GatewayContextV6ClaimsSchema = Schema.Struct({
  act: GatewayActorClaimSchema,
  aud: GatewayAudienceSchema,
  compositionRevision,
  exp: epochSeconds,
  iat: epochSeconds,
  iss: nonEmptyString,
  jti: uuid,
  organizationGovernanceRead: RegisteredGatewayOrganizationGovernanceReadSchema,
  principal: GatewayTrustedPrincipalContextSchema,
  sub: uuid,
  targetBuildMarker,
  ver: Schema.Literal(ORGANIZATION_GOVERNANCE_GATEWAY_ASSERTION_VERSION),
}).check(
  Schema.makeFilter((claims) => [
    ...(claims.exp - claims.iat === GATEWAY_ASSERTION_TTL_SECONDS
      ? []
      : [{ issue: EXACT_LIFETIME_ISSUE, path: ['exp'] }]),
    ...(claims.sub === claims.principal.principalId ? [] : [{ issue: SUBJECT_IS_PRINCIPAL_ISSUE, path: ['sub'] }]),
    ...(claims.act.appId === 'privacy' && claims.act.principalId !== claims.sub
      ? []
      : [{ issue: 'Only the distinct Privacy module actor may carry this human Read', path: ['act'] }]),
    ...((claims.principal.authMethod === 'session' || claims.principal.authMethod === 'api_key') &&
    claims.principal.authenticationNamespaceId !== undefined &&
    claims.principal.impersonatedByPrincipalId === undefined &&
    claims.principal.principalId === claims.organizationGovernanceRead.principalId &&
    claims.principal.tenantId === claims.organizationGovernanceRead.tenantId &&
    claims.principal.legalEntityId === claims.organizationGovernanceRead.governanceLegalEntityId
      ? []
      : [{ issue: 'Version 6 requires the exact original human and governance company', path: ['principal'] }]),
    ...(claims.aud === organizationGovernanceReadOperationContract().appId
      ? []
      : [{ issue: 'The organization governance Read requires its exact audience', path: ['aud'] }]),
  ]),
);
export type GatewayContextV6Claims = typeof GatewayContextV6ClaimsSchema.Type;

export const SupportedGatewayContextClaimsSchema = Schema.Union([
  GatewayContextClaimsSchema,
  GatewayContextV2ClaimsSchema,
  GatewayContextV3ClaimsSchema,
  GatewayContextV4ClaimsSchema,
  GatewayContextV5ClaimsSchema,
  GatewayContextV6ClaimsSchema,
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

/**
 * Whom a module call is done for. `Assertion` carries the verified incoming token of a live request;
 * `Originator` names the action invocation of asynchronous work whose requester the call acts for, and may
 * name the one company that work belongs to when the invocation itself ran in the tenant context. The Shell
 * admits that company only for a workload requester bound in the tenant; a person keeps the company the
 * invocation recorded.
 */
export const GatewayRegisteredAssertionSubjectSchema = Schema.TaggedStruct('RegisteredAssertion', {
  declarationKey: GatewayCapabilityKeySchema,
  expectedPrincipalId: Schema.optionalKey(PrincipalIdSchema),
  operationRequirementKey: Schema.optionalKey(GatewayCapabilityKeySchema),
  processingRequestHash: Schema.optionalKey(compositionRevision),
  recoveryRequestHash: Schema.optionalKey(compositionRevision),
  sourceAssertion: Schema.RedactedFromValue(nonEmptyString),
}).check(
  Schema.makeFilter((subject) =>
    subject.processingRequestHash === undefined || subject.recoveryRequestHash === undefined
      ? undefined
      : 'Processing and recovery request restrictions cannot be combined',
  ),
);

export const GatewayRegisteredAdmissionSubjectSchema = Schema.TaggedStruct('RegisteredAdmission', {
  actionInvocationId: ActionInvocationIdSchema,
  declarationKey: GatewayCapabilityKeySchema,
  expectedAuthContextRef: Schema.optionalKey(nonEmptyString.check(Schema.isMaxLength(500))),
  expectedPrincipalId: Schema.optionalKey(PrincipalIdSchema),
  legalEntityId: Schema.optionalKey(LegalEntityIdSchema),
  operationRequirementKey: Schema.optionalKey(GatewayCapabilityKeySchema),
  sourceActionKey: GatewaySourceActionKeySchema,
  tenantId: TenantIdSchema,
});

export const GatewayRegisteredWorkloadSubjectSchema = Schema.TaggedStruct('RegisteredWorkload', {
  claimId: GatewayClaimIdSchema,
  declarationKey: GatewayCapabilityKeySchema,
  deliveryId: GatewayDeliveryIdSchema,
  expectedPrincipalId: Schema.optionalKey(PrincipalIdSchema),
  legalEntityId: Schema.optionalKey(LegalEntityIdSchema),
  operationRequirementKey: Schema.optionalKey(GatewayCapabilityKeySchema),
  tenantId: TenantIdSchema,
  workerKey: GatewayWorkerKeySchema,
});

export const GatewayAssertionSubjectSchema = Schema.TaggedStruct('Assertion', {
  sourceAssertion: Schema.RedactedFromValue(nonEmptyString),
});

export const GatewayOriginatorSubjectSchema = Schema.TaggedStruct('Originator', {
  actionInvocationId: ActionInvocationIdSchema,
  legalEntityId: Schema.optionalKey(LegalEntityIdSchema),
  tenantId: TenantIdSchema,
});
const privacyDispatchAttempt = Schema.Finite.check(Schema.isInt(), Schema.isGreaterThanOrEqualTo(1));
export const GatewayPrivacyDispatchOperationSchema = Schema.Union([
  Schema.TaggedStruct('SymmyRetention', {}),
  Schema.TaggedStruct('SymmyReceipt', { attempt: Schema.optionalKey(privacyDispatchAttempt) }),
  Schema.TaggedStruct('PrivacyEligibility', {}),
  Schema.TaggedStruct('PrivacyOutcome', { attempt: privacyDispatchAttempt }),
]);
export const GatewayPrivacyDispatchSourceSchema = Schema.Union([
  Schema.TaggedStruct('Worker', {
    claimId: GatewayClaimIdSchema,
    deliveryId: GatewayDeliveryIdSchema,
    tenantId: TenantIdSchema,
    workerKey: GatewayWorkerKeySchema,
  }),
  Schema.TaggedStruct('Dispatch', {
    dispatchInvocationId: ActionInvocationIdSchema,
    legalEntityId: LegalEntityIdSchema,
    tenantId: TenantIdSchema,
  }),
  Schema.TaggedStruct('Assertion', { sourceAssertion: Schema.RedactedFromValue(nonEmptyString) }),
]);
export const GatewayPrivacyDispatchSubjectSchema = Schema.TaggedStruct('PrivacyDispatch', {
  operation: GatewayPrivacyDispatchOperationSchema,
  operationRequirementKey: Schema.optionalKey(GatewayCapabilityKeySchema),
  source: GatewayPrivacyDispatchSourceSchema,
});
export const GatewayOrganizationGovernanceReadSubjectSchema = Schema.TaggedStruct('OrganizationGovernanceRead', {
  requestHash: compositionRevision,
  sourceAssertion: Schema.RedactedFromValue(nonEmptyString),
});
const GatewayRecoverySourceSchema = Schema.Union([
  Schema.TaggedStruct('HistoricalDelivery', {
    deliveryId: GatewayDeliveryIdSchema,
    legalEntityId: Schema.optionalKey(LegalEntityIdSchema),
    tenantId: TenantIdSchema,
    workerKey: GatewayWorkerKeySchema,
  }),
  Schema.TaggedStruct('Worker', {
    claimId: GatewayClaimIdSchema,
    deliveryId: GatewayDeliveryIdSchema,
    legalEntityId: Schema.optionalKey(LegalEntityIdSchema),
    tenantId: TenantIdSchema,
    workerKey: GatewayWorkerKeySchema,
  }),
  Schema.TaggedStruct('Admission', {
    actionInvocationId: ActionInvocationIdSchema,
    legalEntityId: Schema.optionalKey(LegalEntityIdSchema),
    sourceActionKey: GatewaySourceActionKeySchema,
    tenantId: TenantIdSchema,
  }),
]);
export const GatewayRecoveryIntentFields = {
  declarationKey: GatewayCapabilityKeySchema,
  expectedPrincipalId: Schema.optionalKey(PrincipalIdSchema),
  operationRequirementKey: Schema.optionalKey(GatewayCapabilityKeySchema),
  originalActionKey: GatewaySourceActionKeySchema,
  originalIdempotencyKey: nonEmptyString.pipe(Schema.brand('OriginalIdempotencyKey'), Schema.decodeTo(Schema.String)),
  originalPrincipalId: PrincipalIdSchema,
  originalRequestHash: compositionRevision,
  requestHash: compositionRevision,
};
export const GatewayRegisteredRecoverySubjectSchema = Schema.TaggedStruct('RegisteredRecovery', {
  ...GatewayRecoveryIntentFields,
  source: GatewayRecoverySourceSchema,
});
export const GatewayDelegatedSubjectSchema = Schema.Union([
  GatewayPrivacyDispatchSubjectSchema,
  GatewayOrganizationGovernanceReadSubjectSchema,
  GatewayRegisteredAssertionSubjectSchema,
  GatewayRegisteredAdmissionSubjectSchema,
  GatewayRegisteredWorkloadSubjectSchema,
  GatewayRegisteredRecoverySubjectSchema,
  GatewayAssertionSubjectSchema,
  GatewayOriginatorSubjectSchema,
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
  machineContext: Schema.optionalKey(
    Schema.Struct({
      authContextRef: nonEmptyString.check(Schema.isMaxLength(500)),
      bindingIncarnation: uuid,
      principalId: PrincipalIdSchema,
    }),
  ),
  recovery: Schema.optionalKey(RegisteredGatewayRecoverySchema),
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
  issueApiKeyGatewayContextPath: '/shell-super-app-api/auth/api-key/gateway-context',
  issueDelegatedGatewayContextPath: '/shell-super-app-api/auth/delegated/gateway-context',
  issueGatewayContextPath: '/shell-super-app-api/auth/gateway-context',
  ownerId: 'shell-super-app',
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
