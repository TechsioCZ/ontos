import { describe, expect, it } from 'effect-rstest';
import { Effect, Option, Schema } from 'effect';

import { createActionCollector } from '../../../../packages/core-runtime/src/actions/collector.ts';
import { TransitionProcessingActivityPayloadSchema } from '../../shared/actions/transition-processing-activity.ts';
import { CreateProcessingActivityInputSchema } from '../../shared/domain/processing-activity.ts';
import {
  ProcessingActivityRegistryError,
  buildProcessingActivity,
} from '../../src/domain/processing-activity-registry.ts';
import { processingActivityCoverageAuthorityUnavailable } from '../../src/actions/processing-activity-coverage-authority.ts';
import {
  handleTransitionProcessingActivity,
  transitionProcessingActivityAction,
} from '../../src/actions/transition-processing-activity.action.ts';
import type { Services } from '../../src/actions/transition-processing-activity.action.ts';

const tenantId = '00000000-0000-4000-8000-000000000001';
const legalEntityId = '00000000-0000-4000-8000-000000000002';
const actionInvocationId = '00000000-0000-4000-8000-000000000003';
const actor = {
  moduleId: 'core.identity',
  principalId: '00000000-0000-4000-8000-000000000004',
  principalType: 'user',
  tenantId,
} as const;
const responsibilityAssignmentRef = {
  moduleId: 'privacy.core' as const,
  resourceId: 'assignment:1',
  resourceType: 'privacy.core.privacy-responsibility-assignment' as const,
  tenantId,
};
const input = Schema.decodeUnknownSync(CreateProcessingActivityInputSchema)({
  dataCategoryRefs: [
    {
      moduleId: 'privacy.core',
      resourceId: 'category:account',
      resourceType: 'privacy.core.data-category',
      tenantId,
    },
  ],
  dataCoverage: [
    {
      dataCategoryRef: {
        moduleId: 'privacy.core',
        resourceId: 'category:account',
        resourceType: 'privacy.core.data-category',
        tenantId,
      },
      ownerCapability: 'accounts.read',
      ownerModuleId: 'privacy.core',
      recordContentScope: 'account-security',
      systemOfRecordRef: {
        moduleId: 'privacy.core',
        resourceId: 'system:accounts',
        resourceType: 'privacy.core.system-of-record',
        tenantId,
      },
    },
  ],
  processingScope: {
    applicabilityScope: {
      facts: [],
      operation: 'account-security',
      processingScopeRef: { scopeId: 'scope:1', scopeType: 'privacy.processing-scope' },
    },
    purposeRef: {
      moduleId: 'privacy.core',
      resourceId: 'purpose:1',
      resourceType: 'privacy.core.processing-purpose',
      tenantId,
    },
    purposeVersionId: '00000000-0000-4000-8000-000000000005',
    responsibilityAssignmentRefs: [responsibilityAssignmentRef],
  },
  systemOfRecordRefs: [
    {
      moduleId: 'privacy.core',
      resourceId: 'system:accounts',
      resourceType: 'privacy.core.system-of-record',
      tenantId,
    },
  ],
});
const activity = buildProcessingActivity({
  actor,
  createdAt: '2026-09-14T10:00:00Z',
  legalEntityId,
  request: input,
  tenantId,
});
const payload = Schema.decodeUnknownSync(TransitionProcessingActivityPayloadSchema)({
  activityRef: activity.activityRef,
  decisionEvidenceRefs: ['approval:1'],
  effectiveAt: '2026-09-14T11:00:00Z',
  to: 'EFFECTIVE',
});
const scope = {
  authMethod: 'session' as const,
  correlationId: 'processing-activity-authority-action-test',
  legalEntityId,
  principalId: actor.principalId,
  tenantId,
};

const actionContext = (services: Services) => {
  const collector = createActionCollector(
    transitionProcessingActivityAction.descriptor.domainEvents,
    'privacy.core',
    transitionProcessingActivityAction.descriptor.accessEvidencePolicy,
    transitionProcessingActivityAction.descriptor.auditEvidenceSchema,
  );
  return {
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

describe('Processing Activity coverage authority boundary', () => {
  it.effect('rejects caller-supplied coverage when the authoritative seam is unavailable', () =>
    Effect.gen(function* rejectCallerCoverage() {
      const { context } = actionContext({
        authority: processingActivityCoverageAuthorityUnavailable,
        get: () => Effect.succeed(Option.some(activity)),
        transition: () => Effect.die('must not be called'),
      });

      const error = yield* Effect.flip(handleTransitionProcessingActivity(payload, context));

      expect(Schema.is(ProcessingActivityRegistryError)(error)).toBe(true);
      expect(error.code).toBe('privacy_processing_activity_persistence_unavailable');
      expect(error.reason).toContain('not configured');
    }),
  );

  it('does not expose coverage or system-of-record facts in the public transition payload', () => {
    const decoded = Schema.decodeUnknownSync(TransitionProcessingActivityPayloadSchema)(payload);
    expect('dataCoverage' in decoded).toBe(false);
    expect('systemOfRecordRefs' in decoded).toBe(false);
  });
});
