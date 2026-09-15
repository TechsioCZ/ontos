import { describe, expect, it } from 'effect-rstest';
import { Effect, Exit, Option, Schema } from 'effect';

import { createActionCollector } from '../../../../packages/core-runtime/src/actions/collector.ts';
import { RecordNoticeProvisionPayloadSchema } from '../../shared/actions/record-notice-provision.ts';
import { AssignLegalBasisPayloadSchema } from '../../shared/actions/assign-legal-basis.ts';
import { RecordPrivacyApplicabilityPayloadSchema } from '../../shared/actions/record-privacy-applicability.ts';
import { PrivacyApplicabilityDecisionSchema } from '../../shared/domain/privacy-applicability.ts';
import {
  handleCreateProcessingPurpose,
  createProcessingPurposeAction,
} from '../../src/actions/create-processing-purpose.action.ts';
import {
  RecordNoticeProvisionError,
  handleRecordNoticeProvision,
  noticeChannelDeliveryAuthorityUnavailable,
  recordNoticeProvisionAction,
} from '../../src/actions/record-notice-provision.action.ts';
import type {
  NoticeChannelDeliveryAuthorityService,
  RecordNoticeProvisionServices,
} from '../../src/actions/record-notice-provision.action.ts';
import {
  handleRecordConsentDecision,
  recordConsentDecisionAction,
} from '../../src/actions/record-consent-decision.action.ts';
import { handleAssignLegalBasis, assignLegalBasisAction } from '../../src/actions/assign-legal-basis.action.ts';
import {
  handleRecordPrivacyApplicability,
  recordPrivacyApplicabilityAction,
} from '../../src/actions/record-privacy-applicability.action.ts';
import { PrivacyApplicabilityBusinessFactAuthorityError } from '../../src/actions/privacy-applicability-business-fact-authority.ts';
import { makeInMemoryProcessingPurposeRepository } from '../../src/domain/processing-purpose-catalog.ts';
import { makeInMemoryNoticeProvisionRepository } from '../../src/persistence/notice-provision-repository.ts';

const tenantId = '00000000-0000-4000-8000-000000000001';
const legalEntityId = '00000000-0000-4000-8000-000000000002';
const actionInvocationId = '00000000-0000-4000-8000-000000000003';
const scope = {
  authMethod: 'session' as const,
  correlationId: 'privacy-action-test',
  legalEntityId,
  principalId: '00000000-0000-4000-8000-000000000004',
  tenantId,
};

const noticeRequest = Schema.decodeUnknownSync(RecordNoticeProvisionPayloadSchema)({
  actionRef: 'action:notice-provision:1',
  anonymousContextRef: null,
  businessInteractionRef: 'checkout:1',
  channel: 'web',
  claimRef: 'notice-claim:1',
  controllerRef: 'controller:1',
  noticeVersionRef: 'privacy-notice-version:1',
  privacySubjectRef: 'subject:1',
  processingPurposeRef: 'purpose:account',
  processingScopeRef: 'scope:account',
  providedLanguage: 'en-US',
});

const noticeProof = {
  anonymousContextRef: noticeRequest.anonymousContextRef,
  authorityRef: 'channel:web:trusted',
  businessInteractionRef: noticeRequest.businessInteractionRef,
  channel: noticeRequest.channel,
  controllerRef: noticeRequest.controllerRef,
  evidenceRef: 'evidence:provision:1',
  noticeVersionRef: noticeRequest.noticeVersionRef,
  observedAt: '2026-01-01T10:00:00Z',
  privacySubjectRef: noticeRequest.privacySubjectRef,
  processingPurposeRef: noticeRequest.processingPurposeRef,
  processingScopeRef: noticeRequest.processingScopeRef,
  proofKind: 'INTERACTIVE_ACKNOWLEDGEMENT' as const,
  providedLanguage: noticeRequest.providedLanguage,
};

const noticeAuthorityFact = {
  claimRef: noticeRequest.claimRef,
  provision: {
    actionRef: noticeRequest.actionRef,
    anonymousContextRef: noticeRequest.anonymousContextRef,
    businessInteractionRef: noticeRequest.businessInteractionRef,
    channel: noticeRequest.channel,
    channelProof: noticeProof,
    controllerRef: noticeRequest.controllerRef,
    evidenceRef: noticeProof.evidenceRef,
    failureReason: null,
    noticeVersionRef: noticeRequest.noticeVersionRef,
    outcome: 'PROVEN_PROVISION' as const,
    privacySubjectRef: noticeRequest.privacySubjectRef,
    processingPurposeRef: noticeRequest.processingPurposeRef,
    processingScopeRef: noticeRequest.processingScopeRef,
    providedLanguage: noticeRequest.providedLanguage,
    provisionedAt: noticeProof.observedAt,
    provisionId: 'provision:1',
    supersedesProvisionRef: null,
  },
};

const noticeContext = (services: RecordNoticeProvisionServices) => {
  const collector = createActionCollector(
    recordNoticeProvisionAction.descriptor.domainEvents,
    'privacy.core',
    recordNoticeProvisionAction.descriptor.accessEvidencePolicy,
    recordNoticeProvisionAction.descriptor.auditEvidenceSchema,
  );
  return {
    collector,
    context: {
      actionInvocationId,
      addDomainEvent: collector.addDomainEvent,
      addOutboxMessage: collector.addOutboxMessage,
      recordAuditEvidence: collector.recordAuditEvidence,
      recordDataAccess: collector.recordDataAccess,
      scope,
      services,
    },
  };
};

const rejectedNoticeAuthority: NoticeChannelDeliveryAuthorityService = {
  resolve: () =>
    Effect.fail(
      new RecordNoticeProvisionError({
        code: 'privacy_notice_provision_invalid',
        reason: 'The notice channel owner rejected the claim',
      }),
    ),
};

describe('Privacy Actions', () => {
  it.effect('rejects applicability authority from another tenant before resolving caller references', () =>
    Effect.gen(function* rejectsForeignApplicabilityAuthority() {
      const foreignTenantId = '00000000-0000-4000-8000-000000000099';
      const payload = Schema.decodeUnknownSync(RecordPrivacyApplicabilityPayloadSchema)({
        authority: {
          controllerRef: {
            moduleId: 'privacy.core',
            resourceId: 'controller:foreign',
            resourceType: 'privacy.core.controller',
            tenantId: foreignTenantId,
          },
          legalEntityId,
          purposeRef: {
            moduleId: 'privacy.core',
            resourceId: 'purpose:foreign',
            resourceType: 'privacy.core.processing-purpose',
            tenantId: foreignTenantId,
          },
          purposeVersionRef: {
            moduleId: 'privacy.core',
            resourceId: '00000000-0000-4000-8000-000000000098',
            resourceType: 'privacy.core.processing-purpose-version',
            tenantId: foreignTenantId,
          },
          tenantId: foreignTenantId,
        },
        decisionId: 'applicability:foreign',
        proposedActivity: true,
        responsibilityAssignmentRefs: [],
        scope: {
          facts: [],
          operation: 'ACCOUNT_CREATE',
          processingScopeRef: { scopeId: 'scope:account', scopeType: 'privacy.processing-scope' },
        },
      });
      const collector = createActionCollector(
        recordPrivacyApplicabilityAction.descriptor.domainEvents,
        'privacy.core',
        recordPrivacyApplicabilityAction.descriptor.accessEvidencePolicy,
        recordPrivacyApplicabilityAction.descriptor.auditEvidenceSchema,
      );
      const error = yield* Effect.flip(
        handleRecordPrivacyApplicability(payload, {
          actionInvocationId,
          addDomainEvent: collector.addDomainEvent,
          addOutboxMessage: collector.addOutboxMessage,
          recordAuditEvidence: collector.recordAuditEvidence,
          recordDataAccess: collector.recordDataAccess,
          scope,
          services: {
            authority: {
              resolve: () =>
                Effect.fail(
                  new PrivacyApplicabilityBusinessFactAuthorityError({
                    code: 'AUTHORITY_CONFLICT',
                    reason: 'Applicability authority must belong to the trusted Tenant',
                  }),
                ),
              resolveEligibility: () => Effect.die('eligibility authority must not be called by this Action'),
            },
            getPurpose: () => Effect.die('foreign authority must fail before Purpose lookup'),
            listApplicabilityPolicies: () => Effect.die('foreign authority must fail before policy lookup'),
            listResponsibilities: () => Effect.die('foreign authority must fail before responsibility lookup'),
            recordApplicability: () => Effect.die('foreign authority must never be persisted'),
          },
        }),
      );
      expect(error.code).toBe('privacy_action_rejected');
      expect(error.reason).toContain('trusted Tenant');
    }),
  );

  it.effect('creates and retains a Processing Purpose through the Action service seam', () =>
    Effect.gen(function* createPurpose() {
      const repository = makeInMemoryProcessingPurposeRepository();
      const collector = createActionCollector(
        createProcessingPurposeAction.descriptor.domainEvents,
        'privacy.core',
        createProcessingPurposeAction.descriptor.accessEvidencePolicy,
        createProcessingPurposeAction.descriptor.auditEvidenceSchema,
      );
      const result = yield* handleCreateProcessingPurpose(
        {
          businessCode: 'ACCOUNT_SECURITY',
          effectiveFrom: '2026-01-01T00:00:00Z',
          governanceOwnerId: '00000000-0000-4000-8000-000000000005',
          meaning: 'Protect accounts from unauthorized access',
        },
        {
          actionInvocationId,
          addDomainEvent: collector.addDomainEvent,
          addOutboxMessage: collector.addOutboxMessage,
          recordAuditEvidence: collector.recordAuditEvidence,
          recordDataAccess: collector.recordDataAccess,
          scope,
          services: { create: repository.create },
        },
      );

      expect(result.businessCode).toBe('ACCOUNT_SECURITY');
      expect(result.legalEntityId).toBe(legalEntityId);
      expect(collector.snapshot().auditEvidence.purposeId).toBe(result.purposeRef.resourceId);
    }),
  );

  it('rejects a legacy caller-supplied Notice Provision proof at the public schema', () => {
    expect(() =>
      Schema.decodeUnknownSync(RecordNoticeProvisionPayloadSchema)({
        ...noticeRequest,
        channelProof: noticeProof,
        outcome: 'PROVEN_PROVISION',
      }),
    ).toThrow();
  });

  it.live('records successful Notice Provision only from the trusted channel authority', () =>
    Effect.gen(function* recordAuthoritativeProvision() {
      const repository = makeInMemoryNoticeProvisionRepository();
      const { collector, context } = noticeContext({
        authority: { resolve: () => Effect.succeed(noticeAuthorityFact) },
        record: repository.record,
      });

      const result = yield* handleRecordNoticeProvision(noticeRequest, context);
      const retained = yield* repository.findById(tenantId, legalEntityId, result.provisionId);

      expect(Option.isSome(retained)).toBe(true);
      expect(result.channelProof).toEqual(noticeProof);
      expect(result.outcome).toBe('PROVEN_PROVISION');
      expect(collector.snapshot().auditEvidence.provisionId).toBe(result.provisionId);
    }),
  );

  for (const authoritativeOutcome of [
    { failureReason: null, outcome: 'DISPLAYED_WITHOUT_ACKNOWLEDGEMENT' as const },
    { failureReason: 'transport-failed', outcome: 'PROVISION_FAILED' as const },
    { failureReason: 'provider-timeout', outcome: 'PROVISION_INDETERMINATE' as const },
  ]) {
    it.live(`records ${authoritativeOutcome.outcome} without relabeling the authority fact`, () =>
      Effect.gen(function* recordAuthoritativeNonProofFact() {
        const repository = makeInMemoryNoticeProvisionRepository();
        const fact = {
          ...noticeAuthorityFact,
          provision: {
            ...noticeAuthorityFact.provision,
            channelProof: null,
            evidenceRef: null,
            failureReason: authoritativeOutcome.failureReason,
            outcome: authoritativeOutcome.outcome,
            provisionId: `provision:${authoritativeOutcome.outcome}`,
          },
        };
        const { context } = noticeContext({
          authority: { resolve: () => Effect.succeed(fact) },
          record: repository.record,
        });

        const result = yield* handleRecordNoticeProvision(noticeRequest, context);

        expect(result.outcome).toBe(authoritativeOutcome.outcome);
        expect(result.failureReason).toBe(authoritativeOutcome.failureReason);
        expect(result.channelProof).toBeNull();
      }),
    );
  }

  it.live('fails closed when the Notice delivery authority is unavailable', () =>
    Effect.gen(function* rejectUnavailableNoticeAuthority() {
      const repository = makeInMemoryNoticeProvisionRepository();
      const { context } = noticeContext({
        authority: noticeChannelDeliveryAuthorityUnavailable,
        record: repository.record,
      });

      const error = yield* Effect.flip(handleRecordNoticeProvision(noticeRequest, context));
      const retained = yield* repository.findById(tenantId, legalEntityId, noticeAuthorityFact.provision.provisionId);

      expect(error.reason).toContain('not configured');
      expect(Option.isNone(retained)).toBe(true);
    }),
  );

  it.live('preserves a typed rejection from the Notice delivery authority', () =>
    Effect.gen(function* rejectNoticeClaim() {
      const repository = makeInMemoryNoticeProvisionRepository();
      const { context } = noticeContext({ authority: rejectedNoticeAuthority, record: repository.record });

      const error = yield* Effect.flip(handleRecordNoticeProvision(noticeRequest, context));

      expect(Schema.is(RecordNoticeProvisionError)(error)).toBe(true);
      expect(error.reason).toContain('rejected the claim');
    }),
  );

  it.live('rejects Notice proof for a different delivery claim', () =>
    Effect.gen(function* rejectMismatchedNoticeProof() {
      const repository = makeInMemoryNoticeProvisionRepository();
      const { context } = noticeContext({
        authority: { resolve: () => Effect.succeed({ ...noticeAuthorityFact, claimRef: 'notice-claim:other' }) },
        record: repository.record,
      });

      const error = yield* Effect.flip(handleRecordNoticeProvision(noticeRequest, context));

      expect(Schema.is(RecordNoticeProvisionError)(error)).toBe(true);
      expect(error.reason).toContain('different claim or exact notice scope');
    }),
  );

  it.live('rejects Notice proof for a different exact processing scope', () =>
    Effect.gen(function* rejectMismatchedNoticeScope() {
      const repository = makeInMemoryNoticeProvisionRepository();
      const { context } = noticeContext({
        authority: {
          resolve: () =>
            Effect.succeed({
              ...noticeAuthorityFact,
              provision: { ...noticeAuthorityFact.provision, processingScopeRef: 'scope:other' },
            }),
        },
        record: repository.record,
      });

      const error = yield* Effect.flip(handleRecordNoticeProvision(noticeRequest, context));

      expect(Schema.is(RecordNoticeProvisionError)(error)).toBe(true);
      expect(error.reason).toContain('different claim or exact notice scope');
    }),
  );
  it.effect('rejects consent that does not resolve to the authoritative Purpose Version', () =>
    Effect.gen(function* rejectUnresolvedPurposeVersion() {
      const purposeRepository = makeInMemoryProcessingPurposeRepository();
      const purpose = yield* purposeRepository.create(tenantId, legalEntityId, actionInvocationId, {
        businessCode: 'ACCOUNT_SECURITY',
        effectiveFrom: '2026-01-01T00:00:00Z',
        governanceOwnerId: '00000000-0000-4000-8000-000000000005',
        meaning: 'Protect accounts from unauthorized access',
      });
      const collector = createActionCollector(
        recordConsentDecisionAction.descriptor.domainEvents,
        'privacy.core',
        recordConsentDecisionAction.descriptor.accessEvidencePolicy,
        recordConsentDecisionAction.descriptor.auditEvidenceSchema,
      );
      const result = yield* Effect.exit(
        handleRecordConsentDecision(
          {
            decision: {
              actorEvidence: null,
              decision: 'GRANTED',
              decisionId: 'consent:unresolved-version',
              effectiveAt: '2026-02-01T00:00:00Z',
              flowEvidenceRefs: [],
              noticeEvidenceRefs: ['notice-proof:1'],
              provenanceRefs: ['consent-provenance:1'],
              recordedAt: '2026-02-01T00:00:00Z',
              scope: {
                controllerRef: 'controller:1',
                materialDimensions: [],
                privacySubjectRef: {
                  moduleId: 'privacy.core',
                  resourceId: 'subject:1',
                  resourceType: 'privacy.core.privacy-subject',
                  tenantId,
                },
                processingPurposeRef: purpose.purposeRef,
                purposeMeaning: 'Protect accounts from unauthorized access',
                purposeVersionRef: '00000000-0000-4000-8000-000000000099',
                scopeRef: 'scope:account-security',
              },
            },
          },
          {
            actionInvocationId,
            addDomainEvent: collector.addDomainEvent,
            addOutboxMessage: collector.addOutboxMessage,
            recordAuditEvidence: collector.recordAuditEvidence,
            recordDataAccess: collector.recordDataAccess,
            scope,
            services: {
              get: purposeRepository.get,
              recordConsentDecision: (_tenant, _legalEntity, _invocation, decision) => Effect.succeed(decision),
            },
          },
        ),
      );

      expect(Exit.isFailure(result)).toBe(true);
    }),
  );

  it.effect('rejects consent missing a material dimension required by the authoritative Purpose Version', () =>
    Effect.gen(function* rejectMissingPurposeDimension() {
      const purposeRepository = makeInMemoryProcessingPurposeRepository();
      const purpose = yield* purposeRepository.create(tenantId, legalEntityId, actionInvocationId, {
        businessCode: 'CONSENT_CHANNEL',
        effectiveFrom: '2026-01-01T00:00:00Z',
        governanceOwnerId: '00000000-0000-4000-8000-000000000005',
        meaning: 'Send consented channel communications',
        requiredConsentDimensions: ['COMMUNICATION_CHANNEL'],
      });
      const purposeVersion = Option.getOrThrow(Option.fromUndefinedOr(purpose.versions.at(0)));
      const collector = createActionCollector(
        recordConsentDecisionAction.descriptor.domainEvents,
        'privacy.core',
        recordConsentDecisionAction.descriptor.accessEvidencePolicy,
        recordConsentDecisionAction.descriptor.auditEvidenceSchema,
      );
      const result = yield* Effect.exit(
        handleRecordConsentDecision(
          {
            decision: {
              actorEvidence: null,
              decision: 'GRANTED',
              decisionId: 'consent:missing-channel',
              effectiveAt: '2026-02-01T00:00:00Z',
              flowEvidenceRefs: [],
              noticeEvidenceRefs: ['notice-proof:1'],
              provenanceRefs: ['consent-provenance:1'],
              recordedAt: '2026-02-01T00:00:00Z',
              scope: {
                controllerRef: 'controller:1',
                materialDimensions: [],
                privacySubjectRef: {
                  moduleId: 'privacy.core',
                  resourceId: 'subject:1',
                  resourceType: 'privacy.core.privacy-subject',
                  tenantId,
                },
                processingPurposeRef: purpose.purposeRef,
                purposeMeaning: purposeVersion.meaning,
                purposeVersionRef: purposeVersion.versionId,
                scopeRef: 'scope:account-security',
              },
            },
          },
          {
            actionInvocationId,
            addDomainEvent: collector.addDomainEvent,
            addOutboxMessage: collector.addOutboxMessage,
            recordAuditEvidence: collector.recordAuditEvidence,
            recordDataAccess: collector.recordDataAccess,
            scope,
            services: {
              get: purposeRepository.get,
              recordConsentDecision: (_tenant, _legalEntity, _invocation, decision) => Effect.succeed(decision),
            },
          },
        ),
      );

      expect(Exit.isFailure(result)).toBe(true);
    }),
  );

  it('does not accept a caller-supplied applicability decision in the legal-basis payload', () => {
    const decoded = Schema.decodeUnknownSync(AssignLegalBasisPayloadSchema)({
      assignment: {
        actor: { principalId: scope.principalId, tenantId },
        applicabilityDecision: {},
        assignmentRef: {
          moduleId: 'privacy.core',
          resourceId: 'assignment:1',
          resourceType: 'privacy.core.legal-basis-assignment',
          tenantId,
        },
        basis: 'CONTRACT',
        basisVersion: 'basis:v1',
        decision: 'APPROVED',
        effectiveFrom: '2026-01-01T00:00:00Z',
        effectiveTo: null,
        provenance: {
          decisionEvidenceRefs: ['evidence:basis'],
          policyRef: 'policy:applicability',
          policyVersion: 'v1',
          reason: 'contract',
          recordedAt: '2026-01-01T00:00:00Z',
        },
        scope: {
          controllerRef: 'controller:1',
          operation: 'ACCOUNT_CREATE',
          processingScopeRef: { scopeId: 'scope:account', scopeType: 'privacy.processing-scope' },
          purposeRef: {
            moduleId: 'privacy.core',
            resourceId: 'purpose:account',
            resourceType: 'privacy.core.processing-purpose',
            tenantId,
          },
          purposeVersionId: 'purpose-version:1',
        },
      },
    });
    expect('applicabilityDecision' in decoded.assignment).toBe(false);
  });

  it.effect('assigns legal basis from the stored current applicability decision', () =>
    Effect.gen(function* assignFromStoredDecision() {
      const applicabilityDecision = Schema.decodeUnknownSync(PrivacyApplicabilityDecisionSchema)({
        authority: {
          controllerRef: {
            moduleId: 'privacy.core',
            resourceId: 'controller:1',
            resourceType: 'privacy.core.controller',
            tenantId,
          },
          legalEntityId,
          purposeRef: {
            moduleId: 'privacy.core',
            resourceId: 'purpose:account',
            resourceType: 'privacy.core.processing-purpose',
            tenantId,
          },
          purposeVersionRef: {
            moduleId: 'privacy.core',
            resourceId: '00000000-0000-4000-8000-000000000010',
            resourceType: 'privacy.core.processing-purpose-version',
            tenantId,
          },
          tenantId,
        },
        evaluatedAt: '2026-01-01T00:00:00Z',
        evaluatedScope: {
          facts: [
            { dimension: 'CONTROLLER_SCOPE' as const, value: 'controller:1' },
            { dimension: 'PROCESSING_PURPOSE' as const, value: 'purpose:account' },
            { dimension: 'PROCESSING_PURPOSE_VERSION' as const, value: '00000000-0000-4000-8000-000000000010' },
          ],
          operation: 'ACCOUNT_CREATE',
          processingScopeRef: { scopeId: 'scope:account', scopeType: 'privacy.processing-scope' as const },
        },
        evidenceRefs: ['evidence:applicability'],
        outcome: 'APPLICABLE' as const,
        policyIdentities: [{ policyKey: 'policy:applicability', policyVersion: 'v1' }],
        proposedActivity: true,
        reasonCodes: ['explicit_policy_match'],
        responsibilityAssignmentRefs: [],
      });
      const assignment = {
        actor: { principalId: scope.principalId, tenantId },
        assignmentRef: {
          moduleId: 'privacy.core' as const,
          resourceId: 'assignment:1',
          resourceType: 'privacy.core.legal-basis-assignment' as const,
          tenantId,
        },
        basis: 'CONTRACT' as const,
        basisVersion: 'basis:v1',
        decision: 'APPROVED' as const,
        effectiveFrom: '2026-01-01T00:00:00Z',
        effectiveTo: null,
        provenance: {
          decisionEvidenceRefs: ['evidence:basis'],
          policyRef: 'policy:applicability',
          policyVersion: 'v1',
          reason: 'contract',
          recordedAt: '2026-01-01T00:00:00Z',
        },
        scope: {
          controllerRef: 'controller:1',
          operation: 'ACCOUNT_CREATE',
          processingScopeRef: { scopeId: 'scope:account', scopeType: 'privacy.processing-scope' as const },
          purposeRef: {
            moduleId: 'privacy.core' as const,
            resourceId: 'purpose:account',
            resourceType: 'privacy.core.processing-purpose' as const,
            tenantId,
          },
          purposeVersionId: '00000000-0000-4000-8000-000000000010',
        },
      };
      const collector = createActionCollector(
        assignLegalBasisAction.descriptor.domainEvents,
        'privacy.core',
        assignLegalBasisAction.descriptor.accessEvidencePolicy,
        assignLegalBasisAction.descriptor.auditEvidenceSchema,
      );
      const result = yield* handleAssignLegalBasis(
        { assignment },
        {
          actionInvocationId,
          addDomainEvent: collector.addDomainEvent,
          addOutboxMessage: collector.addOutboxMessage,
          recordAuditEvidence: collector.recordAuditEvidence,
          recordDataAccess: collector.recordDataAccess,
          scope,
          services: {
            assignLegalBasis: (_tenant, _legalEntity, _invocation, value) => Effect.succeed(value),
            listApplicabilityDecisions: () => Effect.succeed([applicabilityDecision]),
          },
        },
      );
      expect(result.applicabilityDecision).toEqual(applicabilityDecision);
    }),
  );
});
