import { describe, expect, it } from 'effect-rstest';
import { Effect, Schema } from 'effect';

import {
  authorizeConsentSelfService,
  ConsentSelfServiceAuthorizationError,
  ConsentSelfServiceRequestSchema,
  ConsentSelfServicePathSchema,
  consentDecisionFromSelfService,
  isAccountFreeConsentWithdrawal,
  resolveAndAuthorizeConsentSelfService,
} from '../../shared/domain/privacy-consent-self-service.ts';
import type {
  ConsentSelfServiceAuthorityPorts,
  TrustedOperationConsentAuthorityFact,
  TrustedPortalConsentAuthorityFact,
  TrustedSupportConsentAuthorityFact,
} from '../../shared/domain/privacy-consent-self-service.ts';
import type { ConsentDecision } from '../../shared/domain/privacy-consent-decision.ts';
import type { ConsentScope } from '../../shared/domain/privacy-consent-scope.ts';

const tenantId = '00000000-0000-4000-8000-000000000001';
const principalId = '00000000-0000-4000-8000-000000000002';
const supportPrincipalId = '00000000-0000-4000-8000-000000000003';
const subjectRef = {
  moduleId: 'privacy.core',
  resourceId: 'subject:one',
  resourceType: 'privacy.core.privacy-subject',
  tenantId,
} as const;
const consentScope: ConsentScope = {
  controllerRef: 'controller:one',
  materialDimensions: [],
  privacySubjectRef: subjectRef,
  processingPurposeRef: {
    moduleId: 'privacy.core',
    resourceId: 'purpose:one',
    resourceType: 'privacy.core.processing-purpose',
    tenantId,
  },
  purposeMeaning: 'Remember the selected privacy choice',
  purposeVersionRef: 'purpose-version:one',
  scopeRef: 'scope:one',
};
const consentDecision: ConsentDecision = {
  actorEvidence: {
    actor: { principalId, tenantId },
    attributedAt: '2026-09-14T11:00:00Z',
    authMethod: 'session',
    impersonatedBy: null,
  },
  decision: 'WITHDRAWN',
  decisionId: 'decision:withdrawal',
  effectiveAt: '2026-09-14T11:00:00Z',
  flowEvidenceRefs: ['flow:self-service'],
  noticeEvidenceRefs: ['notice:one'],
  provenanceRefs: ['operation:one'],
  recordedAt: '2026-09-14T11:00:00Z',
  scope: consentScope,
};

const portalPath = {
  kind: 'CURRENT_PROFILE_BINDING' as const,
  operation: 'CONSENT_WITHDRAW' as const,
  operationRef: 'consent-operation:one',
  profileRef: 'profile:one',
  requestRef: 'request:one',
  scopeRef: consentScope.scopeRef,
  subjectRef,
};
const operationPath = {
  credentialRef: 'credential:one',
  kind: 'OPERATION_SCOPED' as const,
  operation: 'CONSENT_WITHDRAW' as const,
  operationRef: 'consent-operation:one',
  requestRef: 'request:one',
  scopeRef: consentScope.scopeRef,
  subjectRef,
};
const supportPath = {
  kind: 'SUPPORT_ASSISTED' as const,
  operation: 'CONSENT_WRITE' as const,
  operationRef: 'consent-operation:support',
  representationRef: 'representation:one',
  requestRef: 'request:support',
  scopeRef: consentScope.scopeRef,
  subjectRef,
  verificationRef: 'verification:one',
};

const requestFor = (path: typeof portalPath | typeof operationPath | typeof supportPath, decision = 'WITHDRAWN') =>
  Schema.decodeUnknownSync(ConsentSelfServiceRequestSchema)({
    decision,
    noticeEvidenceRefs: ['notice:one'],
    path,
    scope: consentScope,
  });

const current = (sourceModuleId: string) => ({
  observedAt: '2026-09-14T11:00:00Z' as const,
  revision: 'revision:one',
  sourceModuleId,
  status: 'CURRENT' as const,
});

const portalFact: TrustedPortalConsentAuthorityFact = {
  actorPrincipalRef: { principalId, tenantId },
  authorizedScope: consentScope,
  binding: {
    bindingRef: 'binding:one',
    principalRef: { principalId, tenantId },
    profileRef: {
      kind: 'RETAIL',
      moduleId: 'commerce.customer-context',
      resourceId: 'profile:one',
      resourceType: 'commerce.customer-context.retail-customer-profile',
      tenantId,
    },
    state: 'ACTIVE',
  },
  bindingFreshness: current('commerce.customer-context'),
  evidenceRefs: ['binding-evidence:one'],
  kind: 'CURRENT_PROFILE_BINDING',
  operation: portalPath.operation,
  operationRef: portalPath.operationRef,
  permissionFreshness: current('core.authorization'),
  permissions: ['retail.consent.manage'],
  scopeRef: consentScope.scopeRef,
  status: 'CURRENT',
  subjectRef,
};

const operationFact: TrustedOperationConsentAuthorityFact = {
  authorizedScope: consentScope,
  evidenceRefs: ['verification-evidence:one'],
  expiresAt: '2026-09-14T12:00:00Z',
  kind: 'OPERATION_SCOPED',
  operation: operationPath.operation,
  operationRef: operationPath.operationRef,
  proofRef: operationPath.credentialRef,
  scopeRef: consentScope.scopeRef,
  status: 'CURRENT',
  subjectRef,
  verifiedAt: '2026-09-14T10:00:00Z',
};

const supportFact: TrustedSupportConsentAuthorityFact = {
  actorPrincipalRef: { principalId: supportPrincipalId, tenantId },
  authorizedScope: consentScope,
  evidenceRefs: ['representation-evidence:one', 'verification-evidence:one'],
  kind: 'SUPPORT_ASSISTED',
  operation: supportPath.operation,
  operationRef: supportPath.operationRef,
  representationRef: supportPath.representationRef,
  representationStatus: 'CURRENT',
  scopeRef: consentScope.scopeRef,
  status: 'CURRENT',
  subjectRef,
  verificationRef: supportPath.verificationRef,
  verificationStatus: 'CURRENT',
};

const principalRef = { principalId, tenantId } as const;

const portsFor = (facts: {
  readonly operation?: TrustedOperationConsentAuthorityFact;
  readonly portal?: TrustedPortalConsentAuthorityFact;
  readonly support?: TrustedSupportConsentAuthorityFact;
}): ConsentSelfServiceAuthorityPorts => ({
  resolveCurrentRetailPortalProfileBinding: () =>
    facts.portal === undefined
      ? Effect.fail(
          new ConsentSelfServiceAuthorizationError({
            code: 'AUTHORITY_UNAVAILABLE',
            reason: 'Commerce authority unavailable',
          }),
        )
      : Effect.succeed(facts.portal),
  resolveSupportAuthority: () =>
    facts.support === undefined
      ? Effect.fail(
          new ConsentSelfServiceAuthorizationError({
            code: 'AUTHORITY_UNAVAILABLE',
            reason: 'Support authority unavailable',
          }),
        )
      : Effect.succeed(facts.support),
  verifyOperationCredential: () =>
    facts.operation === undefined
      ? Effect.fail(
          new ConsentSelfServiceAuthorizationError({
            code: 'AUTHORITY_UNAVAILABLE',
            reason: 'Operation credential unavailable',
          }),
        )
      : Effect.succeed(facts.operation),
});

describe('Consent self-service authoritative boundary', () => {
  it('does not decode caller-supplied binding or permission booleans', () => {
    const decoded = Schema.decodeUnknownSync(ConsentSelfServicePathSchema)({
      ...portalPath,
      bindingState: 'ACTIVE',
      permissionGranted: true,
    });
    expect(decoded).not.toHaveProperty('bindingState');
    expect(decoded).not.toHaveProperty('permissionGranted');
    expect(decoded).toEqual(portalPath);
  });

  it.effect('resolves a current portal binding and exact permission before allowing', () =>
    Effect.gen(function* resolvesCurrentPortalBinding() {
      const request = requestFor(portalPath);
      const authorization = yield* resolveAndAuthorizeConsentSelfService({
        now: '2026-09-14T11:00:00Z',
        ports: portsFor({ portal: portalFact }),
        principalRef,
        request,
      });
      expect(authorization).toMatchObject({ allowed: true, outcome: 'ALLOWED_PROFILE' });
      expect(authorization.actorPrincipalRef).toEqual(principalRef);
    }),
  );

  it('fails closed for revoked or stale portal binding and denied permission', () => {
    const request = requestFor(portalPath);
    expect(
      authorizeConsentSelfService({
        fact: { ...portalFact, binding: { ...portalFact.binding, state: 'REVOKED' }, status: 'REVOKED' },
        now: '2026-09-14T11:00:00Z',
        request,
      }).outcome,
    ).toBe('PROFILE_BINDING_REVOKED');
    expect(
      authorizeConsentSelfService({
        fact: { ...portalFact, permissionFreshness: { ...current('core.authorization'), status: 'STALE' } },
        now: '2026-09-14T11:00:00Z',
        request,
      }).outcome,
    ).toBe('PROFILE_BINDING_STALE');
    expect(
      authorizeConsentSelfService({
        fact: { ...portalFact, permissions: [] },
        now: '2026-09-14T11:00:00Z',
        request,
      }).outcome,
    ).toBe('PROFILE_PERMISSION_REQUIRED');
    expect(
      authorizeConsentSelfService({
        fact: {
          ...portalFact,
          binding: {
            ...portalFact.binding,
            profileRef: {
              ...portalFact.binding.profileRef,
              tenantId: '00000000-0000-4000-8000-000000000099',
            },
          },
        },
        now: '2026-09-14T11:00:00Z',
        request,
      }).outcome,
    ).toBe('PROFILE_PERMISSION_REQUIRED');
  });

  it.effect('rejects a consent scope from a different trusted Tenant before resolving owner authority', () =>
    Effect.gen(function* rejectsCrossTenantScope() {
      let resolved = false;
      const request = requestFor(portalPath);
      const error = yield* Effect.flip(
        resolveAndAuthorizeConsentSelfService({
          now: '2026-09-14T11:00:00Z',
          ports: {
            ...portsFor({ portal: portalFact }),
            resolveCurrentRetailPortalProfileBinding: () => {
              resolved = true;
              return Effect.succeed(portalFact);
            },
          },
          principalRef,
          request: Schema.decodeUnknownSync(ConsentSelfServiceRequestSchema)({
            ...request,
            path: {
              ...request.path,
              subjectRef: { ...request.path.subjectRef, tenantId: '00000000-0000-4000-8000-000000000099' },
            },
            scope: {
              ...request.scope,
              privacySubjectRef: {
                ...request.scope.privacySubjectRef,
                tenantId: '00000000-0000-4000-8000-000000000099',
              },
            },
          }),
        }),
      );
      expect(error.code).toBe('AUTHORITY_CONFLICT');
      expect(resolved).toBe(false);
    }),
  );

  it.effect('requires an operation-scoped proof for the exact subject, operation, and scope', () =>
    Effect.gen(function* verifiesOperationScopedProof() {
      const request = requestFor(operationPath);
      expect(
        yield* resolveAndAuthorizeConsentSelfService({
          now: '2026-09-14T11:00:00Z',
          ports: portsFor({ operation: operationFact }),
          principalRef,
          request,
        }),
      ).toMatchObject({ allowed: true, authority: 'CONSENT_ONLY' });
      expect(
        authorizeConsentSelfService({
          fact: { ...operationFact, scopeRef: 'scope:other' },
          now: '2026-09-14T11:00:00Z',
          request,
        }).outcome,
      ).toBe('OPERATION_CONTEXT_REQUIRED');
      expect(
        authorizeConsentSelfService({
          fact: { ...operationFact, proofRef: 'credential:other' },
          now: '2026-09-14T11:00:00Z',
          request,
        }).outcome,
      ).toBe('OPERATION_CONTEXT_REQUIRED');
      expect(
        authorizeConsentSelfService({
          fact: { ...operationFact, status: 'STALE' },
          now: '2026-09-14T11:00:00Z',
          request,
        }).outcome,
      ).toBe('OPERATION_CONTEXT_STALE');
    }),
  );

  it.effect('preserves the support actor and representation/verification evidence', () =>
    Effect.gen(function* preservesSupportEvidence() {
      const authorization = yield* resolveAndAuthorizeConsentSelfService({
        now: '2026-09-14T11:00:00Z',
        ports: portsFor({ support: supportFact }),
        principalRef: { principalId: supportPrincipalId, tenantId },
        request: requestFor(supportPath),
      });
      expect(authorization).toMatchObject({
        actorPrincipalRef: { principalId: supportPrincipalId, tenantId },
        allowed: true,
        evidenceRefs: ['representation-evidence:one', 'verification-evidence:one'],
        outcome: 'ALLOWED_SUPPORT',
      });
    }),
  );

  it.effect('adds only trusted operation evidence and rejects a mismatched decision scope', () =>
    Effect.gen(function* addsTrustedOperationEvidence() {
      const authorization = authorizeConsentSelfService({
        fact: operationFact,
        now: '2026-09-14T11:00:00Z',
        request: requestFor(operationPath),
      });
      const decision = yield* consentDecisionFromSelfService({ authorization, decision: consentDecision });
      expect(decision.flowEvidenceTrust).toBe('TRUSTED_OPERATION_CONTEXT');
      expect(decision.flowEvidenceRefs).toContain('verification-evidence:one');
      const error = yield* Effect.flip(
        consentDecisionFromSelfService({
          authorization: { ...authorization, scopeRef: 'scope:other' },
          decision: consentDecision,
        }),
      );
      expect(error).toBeInstanceOf(ConsentSelfServiceAuthorizationError);
      expect(isAccountFreeConsentWithdrawal({ authorization, request: requestFor(operationPath) })).toBe(true);
    }),
  );

  it.effect('never materializes a Consent Decision after an explicit authorization denial', () =>
    Effect.gen(function* rejectsDeniedAuthorization() {
      const error = yield* Effect.flip(
        consentDecisionFromSelfService({
          authorization: {
            allowed: false,
            authority: 'CONSENT_ONLY',
            evidenceRefs: ['evidence:denied'],
            outcome: 'OPERATION_CONTEXT_CONFLICT',
            scopeRef: consentScope.scopeRef,
          },
          decision: consentDecision,
        }),
      );
      expect(error.code).toBe('MISSING_AUTHORITY');
    }),
  );
});
