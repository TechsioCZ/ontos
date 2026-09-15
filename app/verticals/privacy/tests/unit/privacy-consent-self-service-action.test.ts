import { describe, expect, it } from 'effect-rstest';
import { Effect, Option, Schema } from 'effect';

import { createActionCollector } from '../../../../packages/core-runtime/src/actions/collector.ts';
import {
  ConsentSelfServicePayloadSchema,
  ConsentSelfServiceResultSchema,
} from '../../shared/actions/consent-self-service.ts';
import {
  ConsentSelfServiceAuthorizationError,
  ConsentSelfServiceRequestSchema,
} from '../../shared/domain/privacy-consent-self-service.ts';
import type {
  ConsentSelfServiceAuthorityPorts,
  TrustedOperationConsentAuthorityFact,
  TrustedPortalConsentAuthorityFact,
} from '../../shared/domain/privacy-consent-self-service.ts';
import type { ConsentScope } from '../../shared/domain/privacy-consent-scope.ts';
import type { ConsentDecision } from '../../shared/domain/privacy-consent-decision.ts';
import {
  consentSelfServiceAction,
  consentSelfServiceAuthorityUnavailable,
  handleConsentSelfService,
} from '../../src/actions/consent-self-service.action.ts';
import type {
  ConsentSelfServiceAuthorityService,
  ConsentSelfServiceServices,
} from '../../src/actions/consent-self-service.action.ts';
import { PrivacyOperationPersistenceError } from '../../src/persistence/privacy-operation-repository.ts';

const tenantId = '00000000-0000-4000-8000-000000000101';
const principalId = '00000000-0000-4000-8000-000000000102';
const legalEntityId = '00000000-0000-4000-8000-000000000103';
const actionInvocationId = '00000000-0000-4000-8000-000000000104';
const subjectRef = {
  moduleId: 'privacy.core',
  resourceId: 'subject:action-test',
  resourceType: 'privacy.core.privacy-subject',
  tenantId,
} as const;
const consentScope: ConsentScope = {
  controllerRef: 'controller:action-test',
  materialDimensions: [],
  privacySubjectRef: subjectRef,
  processingPurposeRef: {
    moduleId: 'privacy.core',
    resourceId: 'purpose:action-test',
    resourceType: 'privacy.core.processing-purpose',
    tenantId,
  },
  purposeMeaning: 'Self-service consent management',
  purposeVersionRef: '00000000-0000-4000-8000-000000000105',
  scopeRef: 'scope:action-test',
};

const portalPath = {
  kind: 'CURRENT_PROFILE_BINDING' as const,
  operation: 'CONSENT_WITHDRAW' as const,
  operationRef: 'operation:portal-action-test',
  profileRef: 'profile:action-test',
  requestRef: 'request:portal-action-test',
  scopeRef: consentScope.scopeRef,
  subjectRef,
};
const operationPath = {
  credentialRef: 'credential:operation-action-test',
  kind: 'OPERATION_SCOPED' as const,
  operation: 'CONSENT_WITHDRAW' as const,
  operationRef: 'operation:operation-action-test',
  requestRef: 'request:operation-action-test',
  scopeRef: consentScope.scopeRef,
  subjectRef,
};

const portalRequest = Schema.decodeUnknownSync(ConsentSelfServiceRequestSchema)({
  decision: 'WITHDRAWN',
  noticeEvidenceRefs: ['notice:action-test'],
  path: portalPath,
  scope: consentScope,
});
const operationRequest = Schema.decodeUnknownSync(ConsentSelfServiceRequestSchema)({
  decision: 'WITHDRAWN',
  noticeEvidenceRefs: ['notice:action-test'],
  path: operationPath,
  scope: consentScope,
});

const current = (sourceModuleId: string) => ({
  observedAt: '2026-09-15T10:00:00Z' as const,
  revision: 'revision:action-test',
  sourceModuleId,
  status: 'CURRENT' as const,
});

const portalFact: TrustedPortalConsentAuthorityFact = {
  actorPrincipalRef: { principalId, tenantId },
  authorizedScope: consentScope,
  binding: {
    bindingRef: 'binding:action-test',
    principalRef: { principalId, tenantId },
    profileRef: {
      kind: 'RETAIL',
      moduleId: 'commerce.customer-context',
      resourceId: portalPath.profileRef,
      resourceType: 'commerce.customer-context.retail-customer-profile',
      tenantId,
    },
    state: 'ACTIVE',
  },
  bindingFreshness: current('commerce.customer-context'),
  evidenceRefs: ['evidence:portal-action-test'],
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
  evidenceRefs: ['evidence:operation-action-test'],
  expiresAt: '2099-01-01T00:00:00Z',
  kind: 'OPERATION_SCOPED',
  operation: operationPath.operation,
  operationRef: operationPath.operationRef,
  proofRef: operationPath.credentialRef,
  scopeRef: consentScope.scopeRef,
  status: 'CURRENT',
  subjectRef,
  verifiedAt: '1960-01-01T00:00:00Z',
};

const authority = (ports: ConsentSelfServiceAuthorityPorts): ConsentSelfServiceAuthorityService => ({ ports });

const makeConsentDecisionServices = (
  recorded: ConsentDecision[],
  requiredConsentDimensions: readonly ('COMMUNICATION_CHANNEL' | 'SITE')[] = [],
) => ({
  get: () =>
    Effect.succeed(
      Option.some({
        businessCode: 'SELF_SERVICE' as const,
        createdAt: '2026-01-01T00:00:00Z' as const,
        governanceOwnerId: '00000000-0000-4000-8000-000000000106',
        legalEntityId,
        lifecycle: 'ACTIVE' as const,
        purposeRef: consentScope.processingPurposeRef,
        retiredAt: null,
        versions: [
          {
            effectiveFrom: '1960-01-01T00:00:00Z' as const,
            effectiveTo: '2099-01-01T00:00:00Z',
            materialChangeAssessment: null,
            meaning: consentScope.purposeMeaning,
            recordedAt: '1960-01-01T00:00:00Z' as const,
            requiredConsentDimensions,
            versionId: consentScope.purposeVersionRef,
            versionNumber: 1,
          },
        ],
      }),
    ),
  recordConsentDecision: (
    _tenantId: string,
    _legalEntityId: string,
    _invocationId: string,
    decision: ConsentDecision,
  ) => {
    recorded.push(decision);
    return Effect.succeed(decision);
  },
});

const contextFor = (
  services: Pick<ConsentSelfServiceServices, 'authority'>,
  recorded: ConsentDecision[] = [],
  requiredConsentDimensions: readonly ('COMMUNICATION_CHANNEL' | 'SITE')[] = [],
) => {
  const collector = createActionCollector(
    consentSelfServiceAction.descriptor.domainEvents,
    'privacy.core',
    consentSelfServiceAction.descriptor.accessEvidencePolicy,
    consentSelfServiceAction.descriptor.auditEvidenceSchema,
  );
  return {
    actionInvocationId,
    addDomainEvent: collector.addDomainEvent,
    addOutboxMessage: collector.addOutboxMessage,
    recordAuditEvidence: collector.recordAuditEvidence,
    recordDataAccess: collector.recordDataAccess,
    scope: {
      authMethod: 'session' as const,
      correlationId: 'privacy-consent-self-service-action-test',
      legalEntityId,
      principalId,
      tenantId,
    },
    services: { ...services, consentDecision: makeConsentDecisionServices(recorded, requiredConsentDimensions) },
  };
};

const portsFor = (facts: {
  readonly operation?: TrustedOperationConsentAuthorityFact;
  readonly portal?: TrustedPortalConsentAuthorityFact;
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
    Effect.fail(
      new ConsentSelfServiceAuthorizationError({
        code: 'AUTHORITY_UNAVAILABLE',
        reason: 'Support authority unavailable',
      }),
    ),
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

describe('Consent self-service governed Action', () => {
  it.effect('runs portal authority resolution through the public Action handler', () =>
    Effect.gen(function* runsPortalAction() {
      const result = yield* handleConsentSelfService(
        Schema.decodeUnknownSync(ConsentSelfServicePayloadSchema)(portalRequest),
        contextFor({ authority: authority(portsFor({ portal: portalFact })) }),
      );

      expect(Schema.encodeUnknownSync(ConsentSelfServiceResultSchema)(result).decision).toMatchObject({
        decision: 'WITHDRAWN',
        flowEvidenceTrust: 'TRUSTED_OPERATION_CONTEXT',
        noticeEvidenceRefs: ['notice:action-test'],
      });
    }),
  );

  it.effect('runs non-account operation proof resolution through the public Action handler', () =>
    Effect.gen(function* runsOperationAction() {
      const result = yield* handleConsentSelfService(
        Schema.decodeUnknownSync(ConsentSelfServicePayloadSchema)(operationRequest),
        contextFor({ authority: authority(portsFor({ operation: operationFact })) }),
      );

      expect(result.authorization).toMatchObject({ allowed: true, authority: 'CONSENT_ONLY' });
      expect(result.decision.flowEvidenceRefs).toEqual(['evidence:operation-action-test']);
    }),
  );

  it.effect('records the authorized Consent Decision through the owner repository', () =>
    Effect.gen(function* recordsConsent() {
      const recorded: ConsentDecision[] = [];
      const result = yield* handleConsentSelfService(
        Schema.decodeUnknownSync(ConsentSelfServicePayloadSchema)(operationRequest),
        contextFor({ authority: authority(portsFor({ operation: operationFact })) }, recorded),
      );

      expect(recorded).toHaveLength(1);
      expect(recorded[0]).toEqual(result.decision);
      expect(result.decision.decisionId).toBe(`consent-self-service:${operationPath.requestRef}`);
    }),
  );

  it.effect('does not persist or emit success evidence when authoritative authorization is denied', () =>
    Effect.gen(function* rejectsDeniedAuthorization() {
      const recorded: ConsentDecision[] = [];
      const error = yield* Effect.flip(
        handleConsentSelfService(
          Schema.decodeUnknownSync(ConsentSelfServicePayloadSchema)(portalRequest),
          contextFor(
            {
              authority: authority(portsFor({ portal: { ...portalFact, permissions: [] } })),
            },
            recorded,
          ),
        ),
      );

      expect(error.code).toBe('privacy_action_rejected');
      expect(recorded).toHaveLength(0);
    }),
  );

  it.effect('fails closed through the Action handler when authority is unavailable', () =>
    Effect.gen(function* rejectsUnavailableAuthority() {
      const error = yield* Effect.flip(
        handleConsentSelfService(
          Schema.decodeUnknownSync(ConsentSelfServicePayloadSchema)(portalRequest),
          contextFor({ authority: consentSelfServiceAuthorityUnavailable }),
        ),
      );

      expect(error).toBeInstanceOf(PrivacyOperationPersistenceError);
      expect(error.code).toBe('privacy_operation_persistence_unavailable');
    }),
  );

  it.effect('rejects a self-service Purpose reference from another tenant', () =>
    Effect.gen(function* rejectsCrossTenantPurpose() {
      const request = Schema.decodeUnknownSync(ConsentSelfServicePayloadSchema)({
        ...operationRequest,
        scope: {
          ...operationRequest.scope,
          processingPurposeRef: {
            ...operationRequest.scope.processingPurposeRef,
            tenantId: '00000000-0000-4000-8000-000000000199',
          },
        },
      });
      const error = yield* Effect.flip(
        handleConsentSelfService(request, contextFor({ authority: authority(portsFor({ operation: operationFact })) })),
      );

      expect(error).toMatchObject({
        code: 'privacy_action_rejected',
        reason: 'Consent self-service authorization denied: OPERATION_CONTEXT_REQUIRED',
      });
    }),
  );

  it.effect('rejects an omitted authoritative required consent dimension', () =>
    Effect.gen(function* rejectsOmittedRequiredDimension() {
      const error = yield* Effect.flip(
        handleConsentSelfService(
          Schema.decodeUnknownSync(ConsentSelfServicePayloadSchema)(operationRequest),
          contextFor({ authority: authority(portsFor({ operation: operationFact })) }, [], ['COMMUNICATION_CHANNEL']),
        ),
      );

      expect(error).toMatchObject({
        code: 'privacy_action_rejected',
        reason: 'Missing material consent dimension: COMMUNICATION_CHANNEL',
      });
    }),
  );
});
