/* oxlint-disable perfectionist/sort-interfaces, perfectionist/sort-object-types, perfectionist/sort-objects -- These schemas and decision records follow the published cross-owner contract order. expires: 2027-03-31. */
import { PrincipalRefSchema } from '@app/core-runtime';
import { Effect, Schema } from 'effect';

import { ConsentDecisionKindSchema } from './privacy-consent-decision.ts';
import type { ConsentDecision } from './privacy-consent-decision.ts';
import { ConsentScopeSchema } from './privacy-consent-scope.ts';
import { PrivacyIsoTimestampSchema } from './privacy-subject.ts';
import { PrivacySubjectRefSchema } from '../resources/privacy-subject.ts';

const Ref = Schema.Trim.check(Schema.isMinLength(1), Schema.isMaxLength(300));
const EvidenceRefs = Schema.Array(Ref).check(Schema.isMinLength(1), Schema.isMaxLength(32));
const Permission = Ref;
const ConsentOperationSchema = Schema.Literals(['CONSENT_READ', 'CONSENT_WRITE', 'CONSENT_WITHDRAW']);
const SupportEvidenceStatusSchema = Schema.Literals(['CURRENT', 'STALE', 'CONFLICT', 'UNAVAILABLE']);
export type ConsentSelfServiceOperation = typeof ConsentOperationSchema.Type;

const RetailProfileRefSchema = Schema.Struct({
  kind: Schema.Literal('RETAIL'),
  moduleId: Schema.Literal('commerce.customer-context'),
  // oxlint-disable-next-line effect-native/no-unbranded-identifier-schema -- Consumer-side opaque owner reference; the Commerce owner validates its branded resource contract. expires: 2027-03-31.
  resourceId: Ref,
  resourceType: Schema.Literal('commerce.customer-context.retail-customer-profile'),
  // oxlint-disable-next-line effect-native/no-unbranded-identifier-schema -- Consumer-side tenant boundary is revalidated by the trusted owner/Core scope. expires: 2027-03-31.
  tenantId: Schema.String.check(Schema.isUUID()),
});
export type RetailProfileRef = typeof RetailProfileRefSchema.Type;

const subjectMatches = (
  left: typeof PrivacySubjectRefSchema.Type,
  right: typeof PrivacySubjectRefSchema.Type,
): boolean =>
  left.moduleId === right.moduleId &&
  left.resourceId === right.resourceId &&
  left.resourceType === right.resourceType &&
  left.tenantId === right.tenantId;

const principalMatches = (left: typeof PrincipalRefSchema.Type, right: typeof PrincipalRefSchema.Type): boolean =>
  left.principalId === right.principalId && left.tenantId === right.tenantId;

const pathMatchesRequest = (path: ConsentSelfServicePath, request: Pick<ConsentSelfServiceRequest, 'scope'>): boolean =>
  subjectMatches(path.subjectRef, request.scope.privacySubjectRef) && path.scopeRef === request.scope.scopeRef;

/**
 * Public input intentionally contains references only. Binding state, granted
 * permissions, and verification outcomes are never accepted from a browser.
 * The server resolves those facts through the owner ports below.
 */
export const ConsentSelfServicePathSchema = Schema.Union([
  Schema.Struct({
    kind: Schema.Literal('CURRENT_PROFILE_BINDING'),
    operation: ConsentOperationSchema,
    operationRef: Ref,
    profileRef: Ref,
    requestRef: Ref,
    scopeRef: Ref,
    subjectRef: PrivacySubjectRefSchema,
  }),
  Schema.Struct({
    credentialRef: Ref,
    kind: Schema.Literal('OPERATION_SCOPED'),
    operation: ConsentOperationSchema,
    operationRef: Ref,
    requestRef: Ref,
    scopeRef: Ref,
    subjectRef: PrivacySubjectRefSchema,
  }),
  Schema.Struct({
    kind: Schema.Literal('SUPPORT_ASSISTED'),
    operation: ConsentOperationSchema,
    operationRef: Ref,
    representationRef: Ref,
    requestRef: Ref,
    scopeRef: Ref,
    subjectRef: PrivacySubjectRefSchema,
    verificationRef: Ref,
  }),
]);
export type ConsentSelfServicePath = typeof ConsentSelfServicePathSchema.Type;

export const ConsentSelfServiceRequestSchema = Schema.Struct({
  decision: ConsentDecisionKindSchema,
  /** These refs are business input; Privacy resolves their authoritative records before commit. */
  noticeEvidenceRefs: EvidenceRefs,
  path: ConsentSelfServicePathSchema,
  scope: ConsentScopeSchema,
}).check(
  Schema.makeFilter(({ path, scope }) =>
    pathMatchesRequest(path, { scope }) ? undefined : 'Self-service path must pin the exact Consent Scope and Subject',
  ),
);
export type ConsentSelfServiceRequest = typeof ConsentSelfServiceRequestSchema.Type;

export const ConsentSelfServiceOutcomeSchema = Schema.Literals([
  'ALLOWED_PROFILE',
  'ALLOWED_OPERATION_SCOPED',
  'ALLOWED_SUPPORT',
  'PROFILE_BINDING_REQUIRED',
  'PROFILE_BINDING_REVOKED',
  'PROFILE_BINDING_STALE',
  'PROFILE_PERMISSION_REQUIRED',
  'PROFILE_AUTHORITY_CONFLICT',
  'PROFILE_AUTHORITY_UNAVAILABLE',
  'OPERATION_CONTEXT_REQUIRED',
  'OPERATION_CONTEXT_EXPIRED',
  'OPERATION_CONTEXT_STALE',
  'OPERATION_CONTEXT_CONFLICT',
  'OPERATION_CONTEXT_UNAVAILABLE',
  'SUPPORT_AUTHORITY_REQUIRED',
  'SUPPORT_AUTHORITY_STALE',
  'SUPPORT_AUTHORITY_CONFLICT',
  'SUPPORT_AUTHORITY_UNAVAILABLE',
]);
export type ConsentSelfServiceOutcome = typeof ConsentSelfServiceOutcomeSchema.Type;

const FreshnessSchema = Schema.Struct({
  observedAt: PrivacyIsoTimestampSchema,
  revision: Schema.optionalKey(Ref),
  // oxlint-disable-next-line effect-native/no-unbranded-identifier-schema -- Source module is an owner-issued bounded reference in this cross-module fact. expires: 2027-03-31.
  sourceModuleId: Ref,
  status: Schema.Literals(['CURRENT', 'STALE', 'UNAVAILABLE', 'INDETERMINATE']),
});
export type ConsentSelfServiceFreshness = typeof FreshnessSchema.Type;

const AuthorityStatusSchema = Schema.Literals(['CURRENT', 'STALE', 'REVOKED', 'CONFLICT', 'UNAVAILABLE']);

const CommonAuthorityFields = {
  actorPrincipalRef: Schema.optionalKey(PrincipalRefSchema),
  authorizedScope: ConsentScopeSchema,
  evidenceRefs: Schema.Array(Ref).check(Schema.isMinLength(1), Schema.isMaxLength(32)),
  operation: ConsentOperationSchema,
  operationRef: Ref,
  scopeRef: Ref,
  subjectRef: PrivacySubjectRefSchema,
} as const;

/**
 * This is an internal server-side fact. It mirrors the useful part of
 * Commerce's public Retail Access Decision read, but is not a public request
 * shape and deliberately has no `permissionGranted` boolean.
 */
export const TrustedPortalConsentAuthorityFactSchema = Schema.Struct({
  ...CommonAuthorityFields,
  binding: Schema.Struct({
    bindingRef: Ref,
    profileRef: RetailProfileRefSchema,
    principalRef: PrincipalRefSchema,
    state: Schema.Literals(['ACTIVE', 'REVOKED']),
  }),
  bindingFreshness: FreshnessSchema,
  kind: Schema.Literal('CURRENT_PROFILE_BINDING'),
  permissionFreshness: FreshnessSchema,
  permissions: Schema.Array(Permission),
  status: AuthorityStatusSchema,
});
export type TrustedPortalConsentAuthorityFact = typeof TrustedPortalConsentAuthorityFactSchema.Type;

export const TrustedOperationConsentAuthorityFactSchema = Schema.Struct({
  ...CommonAuthorityFields,
  expiresAt: PrivacyIsoTimestampSchema,
  kind: Schema.Literal('OPERATION_SCOPED'),
  proofRef: Ref,
  status: AuthorityStatusSchema,
  verifiedAt: PrivacyIsoTimestampSchema,
});
export type TrustedOperationConsentAuthorityFact = typeof TrustedOperationConsentAuthorityFactSchema.Type;

export const TrustedSupportConsentAuthorityFactSchema = Schema.Struct({
  ...CommonAuthorityFields,
  kind: Schema.Literal('SUPPORT_ASSISTED'),
  representationRef: Ref,
  representationStatus: SupportEvidenceStatusSchema,
  status: AuthorityStatusSchema,
  verificationRef: Ref,
  verificationStatus: SupportEvidenceStatusSchema,
});
export type TrustedSupportConsentAuthorityFact = typeof TrustedSupportConsentAuthorityFactSchema.Type;

export const TrustedConsentSelfServiceAuthorityFactSchema = Schema.Union([
  TrustedPortalConsentAuthorityFactSchema,
  TrustedOperationConsentAuthorityFactSchema,
  TrustedSupportConsentAuthorityFactSchema,
]);
export type TrustedConsentSelfServiceAuthorityFact = typeof TrustedConsentSelfServiceAuthorityFactSchema.Type;

export const ConsentSelfServiceAuthorizationSchema = Schema.Struct({
  actorPrincipalRef: Schema.optionalKey(PrincipalRefSchema),
  allowed: Schema.Boolean,
  authority: Schema.Literals(['CONSENT_ONLY', 'RETAIL_PROFILE_CONSENT', 'SUPPORT_ASSISTED_CONSENT']),
  evidenceRefs: Schema.Array(Ref).check(Schema.isMinLength(1), Schema.isMaxLength(32)),
  outcome: ConsentSelfServiceOutcomeSchema,
  scopeRef: Ref,
});
export type ConsentSelfServiceAuthorization = typeof ConsentSelfServiceAuthorizationSchema.Type;

export class ConsentSelfServiceAuthorizationError extends Schema.TaggedError<ConsentSelfServiceAuthorizationError>()(
  'ConsentSelfServiceAuthorizationError',
  {
    code: Schema.Literals([
      'AUTHORITY_CONFLICT',
      'AUTHORITY_UNAVAILABLE',
      'CREDENTIAL_EXPIRED',
      'CREDENTIAL_SCOPE_MISMATCH',
      'MISSING_AUTHORITY',
    ]),
    reason: Schema.String,
  },
) {}

const denied = (input: {
  readonly actorPrincipalRef: typeof PrincipalRefSchema.Type | undefined;
  readonly authority: ConsentSelfServiceAuthorization['authority'];
  readonly evidenceRefs: readonly string[];
  readonly outcome: ConsentSelfServiceOutcome;
  readonly scopeRef: string;
}): ConsentSelfServiceAuthorization => {
  const authorization = {
    allowed: false,
    authority: input.authority,
    evidenceRefs: input.evidenceRefs,
    outcome: input.outcome,
    scopeRef: input.scopeRef,
  } satisfies Omit<ConsentSelfServiceAuthorization, 'actorPrincipalRef'>;
  if (input.actorPrincipalRef === undefined) {
    return authorization;
  }
  return { ...authorization, actorPrincipalRef: input.actorPrincipalRef };
};

const allowed = (input: {
  readonly actorPrincipalRef: typeof PrincipalRefSchema.Type | undefined;
  readonly authority: ConsentSelfServiceAuthorization['authority'];
  readonly evidenceRefs: readonly string[];
  readonly outcome: ConsentSelfServiceOutcome;
  readonly scopeRef: string;
}): ConsentSelfServiceAuthorization => {
  const authorization = {
    allowed: true,
    authority: input.authority,
    evidenceRefs: input.evidenceRefs,
    outcome: input.outcome,
    scopeRef: input.scopeRef,
  } satisfies Omit<ConsentSelfServiceAuthorization, 'actorPrincipalRef'>;
  if (input.actorPrincipalRef === undefined) {
    return authorization;
  }
  return { ...authorization, actorPrincipalRef: input.actorPrincipalRef };
};

const freshnessIsCurrent = (freshness: ConsentSelfServiceFreshness): boolean => freshness.status === 'CURRENT';
const sameConsentScope = Schema.toEquivalence(ConsentScopeSchema);

const operationMatches = (
  request: ConsentSelfServiceRequest,
  fact: TrustedConsentSelfServiceAuthorityFact,
): boolean => {
  const commonMatches = [
    pathMatchesRequest(request.path, request),
    request.path.operation === fact.operation,
    request.path.operationRef === fact.operationRef,
    request.path.scopeRef === fact.scopeRef,
    subjectMatches(request.scope.privacySubjectRef, fact.subjectRef),
    sameConsentScope(request.scope, fact.authorizedScope),
  ].every(Boolean);
  if (!commonMatches) {
    return false;
  }
  if (request.path.kind === 'OPERATION_SCOPED') {
    return fact.kind === 'OPERATION_SCOPED' && fact.proofRef === request.path.credentialRef;
  }
  if (request.path.kind === 'SUPPORT_ASSISTED') {
    return (
      fact.kind === 'SUPPORT_ASSISTED' &&
      fact.representationRef === request.path.representationRef &&
      fact.verificationRef === request.path.verificationRef
    );
  }
  return true;
};

const authorityForFact = (
  fact: TrustedConsentSelfServiceAuthorityFact,
): ConsentSelfServiceAuthorization['authority'] => {
  if (fact.kind === 'CURRENT_PROFILE_BINDING') {
    return 'RETAIL_PROFILE_CONSENT';
  }
  if (fact.kind === 'SUPPORT_ASSISTED') {
    return 'SUPPORT_ASSISTED_CONSENT';
  }
  return 'CONSENT_ONLY';
};

const mismatchOutcome = (fact: TrustedConsentSelfServiceAuthorityFact): ConsentSelfServiceOutcome => {
  if (fact.kind === 'CURRENT_PROFILE_BINDING') {
    return 'PROFILE_BINDING_REQUIRED';
  }
  if (fact.kind === 'SUPPORT_ASSISTED') {
    return 'SUPPORT_AUTHORITY_REQUIRED';
  }
  return 'OPERATION_CONTEXT_REQUIRED';
};

const profileBindingStatusOutcome = (
  fact: Extract<TrustedConsentSelfServiceAuthorityFact, { readonly kind: 'CURRENT_PROFILE_BINDING' }>,
):
  | Extract<
      ConsentSelfServiceOutcome,
      | 'PROFILE_BINDING_REVOKED'
      | 'PROFILE_BINDING_STALE'
      | 'PROFILE_AUTHORITY_CONFLICT'
      | 'PROFILE_AUTHORITY_UNAVAILABLE'
    >
  | undefined => {
  if (fact.status === 'REVOKED' || fact.binding.state === 'REVOKED') {
    return 'PROFILE_BINDING_REVOKED';
  }
  if (
    fact.status === 'STALE' ||
    !freshnessIsCurrent(fact.bindingFreshness) ||
    !freshnessIsCurrent(fact.permissionFreshness)
  ) {
    return 'PROFILE_BINDING_STALE';
  }
  if (fact.status === 'CONFLICT') {
    return 'PROFILE_AUTHORITY_CONFLICT';
  }
  return fact.status === 'UNAVAILABLE' ? 'PROFILE_AUTHORITY_UNAVAILABLE' : undefined;
};

const authorizeProfileBinding = (
  fact: Extract<TrustedConsentSelfServiceAuthorityFact, { readonly kind: 'CURRENT_PROFILE_BINDING' }>,
  request: ConsentSelfServiceRequest,
): ConsentSelfServiceAuthorization => {
  const actorPrincipalRef = fact.actorPrincipalRef ?? fact.binding.principalRef;
  const base = {
    authority: 'RETAIL_PROFILE_CONSENT' as const,
    evidenceRefs: fact.evidenceRefs,
    scopeRef: request.scope.scopeRef,
  };
  const statusOutcome = profileBindingStatusOutcome(fact);
  if (statusOutcome !== undefined) {
    return denied({ ...base, outcome: statusOutcome, actorPrincipalRef });
  }
  const requestedProfileRef = request.path.kind === 'CURRENT_PROFILE_BINDING' ? request.path.profileRef : undefined;
  const sameTenant =
    fact.binding.profileRef.tenantId === request.scope.privacySubjectRef.tenantId &&
    fact.binding.principalRef.tenantId === request.scope.privacySubjectRef.tenantId;
  if (
    requestedProfileRef !== fact.binding.profileRef.resourceId ||
    !sameTenant ||
    !fact.permissions.includes('retail.consent.manage')
  ) {
    return denied({ ...base, outcome: 'PROFILE_PERMISSION_REQUIRED', actorPrincipalRef });
  }
  return allowed({ ...base, outcome: 'ALLOWED_PROFILE', actorPrincipalRef });
};

const authorizeOperationScoped = (
  fact: Extract<TrustedConsentSelfServiceAuthorityFact, { readonly kind: 'OPERATION_SCOPED' }>,
  request: ConsentSelfServiceRequest,
  now: string,
): ConsentSelfServiceAuthorization => {
  const base = {
    authority: 'CONSENT_ONLY' as const,
    evidenceRefs: fact.evidenceRefs,
    scopeRef: request.scope.scopeRef,
    actorPrincipalRef: fact.actorPrincipalRef,
  };
  if (fact.status === 'REVOKED' || fact.status === 'STALE') {
    return denied({ ...base, outcome: 'OPERATION_CONTEXT_STALE' });
  }
  if (fact.status === 'CONFLICT') {
    return denied({ ...base, outcome: 'OPERATION_CONTEXT_CONFLICT' });
  }
  if (fact.status === 'UNAVAILABLE') {
    return denied({ ...base, outcome: 'OPERATION_CONTEXT_UNAVAILABLE' });
  }
  if (
    fact.actorPrincipalRef !== undefined &&
    fact.actorPrincipalRef.tenantId !== request.scope.privacySubjectRef.tenantId
  ) {
    return denied({ ...base, outcome: 'OPERATION_CONTEXT_CONFLICT' });
  }
  if (fact.expiresAt <= now || fact.verifiedAt > now) {
    return denied({ ...base, outcome: 'OPERATION_CONTEXT_EXPIRED' });
  }
  return allowed({ ...base, outcome: 'ALLOWED_OPERATION_SCOPED' });
};

const authorizeSupportAssisted = (
  fact: Extract<TrustedConsentSelfServiceAuthorityFact, { readonly kind: 'SUPPORT_ASSISTED' }>,
  request: ConsentSelfServiceRequest,
): ConsentSelfServiceAuthorization => {
  const base = {
    authority: 'SUPPORT_ASSISTED_CONSENT' as const,
    evidenceRefs: fact.evidenceRefs,
    scopeRef: request.scope.scopeRef,
    actorPrincipalRef: fact.actorPrincipalRef,
  };
  if (fact.status === 'STALE' || fact.status === 'REVOKED') {
    return denied({ ...base, outcome: 'SUPPORT_AUTHORITY_STALE' });
  }
  if (fact.status === 'CONFLICT') {
    return denied({ ...base, outcome: 'SUPPORT_AUTHORITY_CONFLICT' });
  }
  if (
    fact.status === 'UNAVAILABLE' ||
    fact.representationStatus !== 'CURRENT' ||
    fact.verificationStatus !== 'CURRENT' ||
    fact.evidenceRefs.length === 0
  ) {
    return denied({ ...base, outcome: 'SUPPORT_AUTHORITY_UNAVAILABLE' });
  }
  return allowed({ ...base, outcome: 'ALLOWED_SUPPORT' });
};

/** Pure authorization decision using only a server-resolved authority fact. */
export const authorizeConsentSelfService = (input: {
  readonly fact: TrustedConsentSelfServiceAuthorityFact;
  readonly now: string;
  readonly request: ConsentSelfServiceRequest;
}): ConsentSelfServiceAuthorization => {
  const { fact, request } = input;
  if (!operationMatches(request, fact)) {
    return denied({
      actorPrincipalRef: fact.actorPrincipalRef,
      authority: authorityForFact(fact),
      evidenceRefs: fact.evidenceRefs,
      outcome: mismatchOutcome(fact),
      scopeRef: request.scope.scopeRef,
    });
  }
  if (fact.kind === 'CURRENT_PROFILE_BINDING') {
    return authorizeProfileBinding(fact, request);
  }
  if (fact.kind === 'OPERATION_SCOPED') {
    return authorizeOperationScoped(fact, request, input.now);
  }
  return authorizeSupportAssisted(fact, request);
};

export interface ConsentSelfServiceAuthorityPorts {
  /** Adapter over Commerce's public current binding/access read. */
  readonly resolveCurrentRetailPortalProfileBinding: (input: {
    readonly principalRef: typeof PrincipalRefSchema.Type;
    readonly profileRef: string;
    readonly request: ConsentSelfServiceRequest;
  }) => Effect.Effect<TrustedPortalConsentAuthorityFact, ConsentSelfServiceAuthorizationError>;
  /** Adapter over the supported operation-scoped verification provider. */
  readonly verifyOperationCredential: (input: {
    readonly credentialRef: string;
    readonly now: string;
    readonly request: ConsentSelfServiceRequest;
  }) => Effect.Effect<TrustedOperationConsentAuthorityFact, ConsentSelfServiceAuthorizationError>;
  /** Adapter over the governed support representation/verification evidence. */
  readonly resolveSupportAuthority: (input: {
    readonly principalRef: typeof PrincipalRefSchema.Type;
    readonly request: ConsentSelfServiceRequest;
  }) => Effect.Effect<TrustedSupportConsentAuthorityFact, ConsentSelfServiceAuthorizationError>;
}

/**
 * Server-side orchestration. The public request supplies only references; the
 * ports must resolve current owner/Core facts before the pure helper runs.
 */
export const resolveAndAuthorizeConsentSelfService = (input: {
  readonly now: string;
  readonly principalRef: typeof PrincipalRefSchema.Type;
  readonly request: ConsentSelfServiceRequest;
  readonly ports: ConsentSelfServiceAuthorityPorts;
}): Effect.Effect<ConsentSelfServiceAuthorization, ConsentSelfServiceAuthorizationError> => {
  const { now, ports, principalRef, request } = input;
  if (request.scope.privacySubjectRef.tenantId !== principalRef.tenantId) {
    return Effect.fail(
      new ConsentSelfServiceAuthorizationError({
        code: 'AUTHORITY_CONFLICT',
        reason: 'Consent self-service scope must belong to the trusted Tenant',
      }),
    );
  }
  const { path } = request;
  if (path.kind === 'CURRENT_PROFILE_BINDING') {
    return ports.resolveCurrentRetailPortalProfileBinding({ principalRef, profileRef: path.profileRef, request }).pipe(
      Effect.map((fact) =>
        authorizeConsentSelfService({
          fact: principalMatches(fact.binding.principalRef, principalRef) ? fact : { ...fact, status: 'CONFLICT' },
          now,
          request,
        }),
      ),
    );
  }
  if (path.kind === 'OPERATION_SCOPED') {
    return ports.verifyOperationCredential({ credentialRef: path.credentialRef, now, request }).pipe(
      Effect.map((fact) =>
        authorizeConsentSelfService({
          fact:
            fact.actorPrincipalRef !== undefined && !principalMatches(fact.actorPrincipalRef, principalRef)
              ? { ...fact, status: 'CONFLICT' }
              : fact,
          now,
          request,
        }),
      ),
    );
  }
  return ports.resolveSupportAuthority({ principalRef, request }).pipe(
    Effect.map((fact) =>
      authorizeConsentSelfService({
        fact:
          fact.actorPrincipalRef !== undefined && principalMatches(fact.actorPrincipalRef, principalRef)
            ? fact
            : { ...fact, status: 'CONFLICT' },
        now,
        request,
      }),
    ),
  );
};

/** Account-free withdrawal remains possible only on an authorized operation path. */
export const isAccountFreeConsentWithdrawal = (input: {
  readonly authorization: ConsentSelfServiceAuthorization;
  readonly request: ConsentSelfServiceRequest;
}): boolean =>
  input.authorization.allowed &&
  input.authorization.authority === 'CONSENT_ONLY' &&
  input.request.decision === 'WITHDRAWN' &&
  input.request.path.kind === 'OPERATION_SCOPED';

/** Keep the shared immutable decision contract as the only persisted fact. */
export const consentDecisionFromSelfService = (input: {
  readonly authorization: ConsentSelfServiceAuthorization;
  readonly decision: ConsentDecision;
}): Effect.Effect<ConsentDecision, ConsentSelfServiceAuthorizationError> => {
  const trustedAllowOutcome =
    input.authorization.outcome === 'ALLOWED_PROFILE' ||
    input.authorization.outcome === 'ALLOWED_OPERATION_SCOPED' ||
    input.authorization.outcome === 'ALLOWED_SUPPORT';
  if (!input.authorization.allowed || !trustedAllowOutcome || input.authorization.evidenceRefs.length === 0) {
    return Effect.fail(
      new ConsentSelfServiceAuthorizationError({
        code: 'MISSING_AUTHORITY',
        reason: 'Consent self-service requires a trusted authorization allow',
      }),
    );
  }
  if (input.decision.scope.scopeRef !== input.authorization.scopeRef) {
    return Effect.fail(
      new ConsentSelfServiceAuthorizationError({
        code: 'CREDENTIAL_SCOPE_MISMATCH',
        reason: 'Consent decision scope does not match the authorized self-service operation',
      }),
    );
  }
  return Effect.succeed({
    ...input.decision,
    flowEvidenceRefs: [...new Set([...input.decision.flowEvidenceRefs, ...input.authorization.evidenceRefs])],
    flowEvidenceTrust: 'TRUSTED_OPERATION_CONTEXT' as const,
  });
};
