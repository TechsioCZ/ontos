import { describe, expect, it } from 'effect-rstest';
import { Effect, Exit, Schema } from 'effect';

import { makeInMemoryProcessingActivityRegistry } from '../../src/domain/processing-activity-registry.ts';
import type { CreateProcessingActivityInput } from '../../src/domain/processing-activity-registry.ts';
import { PrivacyApplicabilityDecisionSchema } from '../../shared/domain/privacy-applicability.ts';

const tenantId = '00000000-0000-4000-8000-000000000001';
const createInvocationId = '00000000-0000-4000-8000-000000000006';
const transitionInvocationId = '00000000-0000-4000-8000-000000000007';
const actor = {
  moduleId: 'core.identity',
  principalId: '00000000-0000-4000-8000-000000000002',
  principalType: 'user',
  tenantId,
} as const;
const purpose = {
  businessCode: 'ACCOUNT_SECURITY' as const,
  createdAt: '2026-01-01T00:00:00Z',
  governanceOwnerId: '00000000-0000-4000-8000-000000000003',
  legalEntityId: '00000000-0000-4000-8000-000000000005',
  lifecycle: 'ACTIVE' as const,
  purposeRef: {
    moduleId: 'privacy.core' as const,
    resourceId: 'purpose-1',
    resourceType: 'privacy.core.processing-purpose' as const,
    tenantId,
  },
  retiredAt: null,
  versions: [
    {
      effectiveFrom: '2026-01-01T00:00:00Z',
      effectiveTo: null,
      meaning: 'Protect accounts',
      recordedAt: '2026-01-01T00:00:00Z',
      versionId: '00000000-0000-4000-8000-000000000004',
      versionNumber: 1,
    },
  ],
};
const scope = {
  facts: [{ dimension: 'PROCESSING_PURPOSE' as const, value: 'ACCOUNT_SECURITY' }],
  operation: 'account-security',
  processingScopeRef: { scopeId: 'scope-1', scopeType: 'privacy.processing-scope' as const },
};
const assignment = {
  moduleId: 'privacy.core' as const,
  resourceId: 'assignment-1',
  resourceType: 'privacy.core.privacy-responsibility-assignment' as const,
  tenantId,
};
const applicabilityDecision = Schema.decodeUnknownSync(PrivacyApplicabilityDecisionSchema)({
  evaluatedAt: '2026-01-01T00:00:00Z',
  evaluatedScope: scope,
  evidenceRefs: ['policy-evidence'],
  outcome: 'APPLICABLE',
  policyIdentities: [{ policyKey: 'privacy.applicability.eu-eea.v1', policyVersion: '1' }],
  proposedActivity: true,
  reasonCodes: ['explicit_policy_match'],
  responsibilityAssignmentRefs: [assignment],
});

const input: CreateProcessingActivityInput = {
  applicabilityDecisions: [applicabilityDecision],
  legalBasisAssignmentRefs: ['legal-basis-1'],
  processingScope: {
    applicabilityScope: scope,
    purposeRef: purpose.purposeRef,
    purposeVersionId: purpose.versions[0].versionId,
    responsibilityAssignmentRefs: [assignment],
  },
  retentionRuleRefs: ['retention-rule-1'],
};

describe('Processing Activity registry', () => {
  it.effect('keeps a proposed activity distinct until complete approved inputs activate it', () =>
    Effect.gen(function* rejectsIncompleteActivation() {
      const registry = makeInMemoryProcessingActivityRegistry();
      const created = yield* registry.create(tenantId, purpose.legalEntityId, actor, createInvocationId, {
        ...input,
        legalBasisAssignmentRefs: [],
        retentionRuleRefs: [],
      });
      expect(created.currentLifecycle).toBe('PROPOSED');
      const transition = yield* Effect.exit(
        registry.transition(
          tenantId,
          purpose.legalEntityId,
          created.activityRef.resourceId,
          actor,
          transitionInvocationId,
          'EFFECTIVE',
          ['approval-1'],
          '2026-02-01T00:00:00Z',
        ),
      );
      expect(Exit.isFailure(transition)).toBe(true);
    }),
  );

  it.effect('requires explicit applicability and prevents resurrection after ending', () =>
    Effect.gen(function* preventsResurrection() {
      const registry = makeInMemoryProcessingActivityRegistry();
      const created = yield* registry.create(tenantId, purpose.legalEntityId, actor, createInvocationId, input);
      const effective = yield* registry.transition(
        tenantId,
        purpose.legalEntityId,
        created.activityRef.resourceId,
        actor,
        transitionInvocationId,
        'EFFECTIVE',
        ['approval-1'],
        '2026-02-01T00:00:00Z',
      );
      const ended = yield* registry.transition(
        tenantId,
        purpose.legalEntityId,
        effective.activityRef.resourceId,
        actor,
        '00000000-0000-4000-8000-000000000008',
        'ENDED',
        ['end-1'],
        '2026-03-01T00:00:00Z',
      );
      expect(ended.currentLifecycle).toBe('ENDED');
      const resurrection = yield* Effect.exit(
        registry.transition(
          tenantId,
          purpose.legalEntityId,
          ended.activityRef.resourceId,
          actor,
          '00000000-0000-4000-8000-000000000009',
          'EFFECTIVE',
          ['resurrection'],
          '2026-04-01T00:00:00Z',
        ),
      );
      expect(Exit.isFailure(resurrection)).toBe(true);
    }),
  );
});
