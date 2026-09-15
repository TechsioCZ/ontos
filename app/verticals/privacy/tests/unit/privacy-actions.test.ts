import { describe, expect, it } from 'effect-rstest';
import { Effect, Option } from 'effect';

import { createActionCollector } from '../../../../packages/core-runtime/src/actions/collector.ts';
import {
  handleCreateProcessingPurpose,
  createProcessingPurposeAction,
} from '../../src/actions/create-processing-purpose.action.ts';
import {
  handleRecordNoticeProvision,
  recordNoticeProvisionAction,
} from '../../src/actions/record-notice-provision.action.ts';
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

describe('Privacy Actions', () => {
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

  it.live('records Notice Provision evidence idempotently through its Action', () =>
    Effect.gen(function* recordProvision() {
      const repository = makeInMemoryNoticeProvisionRepository();
      const collector = createActionCollector(
        recordNoticeProvisionAction.descriptor.domainEvents,
        'privacy.core',
        recordNoticeProvisionAction.descriptor.accessEvidencePolicy,
        recordNoticeProvisionAction.descriptor.auditEvidenceSchema,
      );
      const payload = {
        actionRef: 'action:notice-provision:1',
        anonymousContextRef: null,
        businessInteractionRef: 'checkout:1',
        channel: 'web',
        channelProof: {
          authorityRef: 'channel:web:trusted',
          channel: 'web',
          evidenceRef: 'evidence:provision:1',
          observedAt: '2026-01-01T10:00:00Z',
          proofKind: 'INTERACTIVE_ACKNOWLEDGEMENT' as const,
        },
        controllerRef: 'controller:1',
        evidenceRef: 'evidence:provision:1',
        failureReason: null,
        noticeVersionRef: 'privacy-notice-version:1',
        outcome: 'PROVEN_PROVISION' as const,
        privacySubjectRef: 'subject:1',
        processingPurposeRef: 'purpose:account',
        processingScopeRef: 'scope:account',
        providedLanguage: 'en-US',
        provisionedAt: '2026-01-01T10:00:00Z',
        provisionId: 'provision:1',
        recordedAt: '2026-01-01T10:00:01Z',
        supersedesProvisionRef: null,
      };
      const context = {
        actionInvocationId,
        addDomainEvent: collector.addDomainEvent,
        addOutboxMessage: collector.addOutboxMessage,
        recordAuditEvidence: collector.recordAuditEvidence,
        recordDataAccess: collector.recordDataAccess,
        scope,
        services: { record: repository.record },
      };

      const first = yield* handleRecordNoticeProvision(payload, context);
      const retained = yield* repository.findById(tenantId, legalEntityId, first.provisionId);

      expect(Option.isSome(retained)).toBe(true);
      expect(collector.snapshot().auditEvidence.provisionId).toBe(first.provisionId);
    }),
  );
});
