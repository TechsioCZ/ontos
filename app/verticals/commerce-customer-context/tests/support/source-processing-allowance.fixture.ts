import { DateTime, Effect } from 'effect';

import type { CommerceSourceProcessingEligibilityService } from '../../src/integrations/source-processing-eligibility.ts';

const fixtureAuthority = 'internal-test-source-processing';

/** A current, owner-local Privacy decision for integration tests that exercise Commerce, not Privacy. */
export const allowFixtureSourceProcessing: CommerceSourceProcessingEligibilityService['check'] = (
  scope,
  input,
  requirementKey,
) => {
  const { legalEntityId, tenantId } = scope;
  if (legalEntityId === undefined) {
    return Effect.die('The source processing fixture requires a legal entity');
  }
  return DateTime.now.pipe(
    Effect.map((now) => {
      const evaluatedAt = DateTime.formatIso(now);
      return {
        authorityIncarnation: fixtureAuthority,
        authorityRevision: '1',
        evaluatedAt,
        evidence: {
          authoritativeReferences: [],
          currentnessConditions: [],
          evaluatedScope: {
            controllerRef: legalEntityId,
            dataCategoryRefs: ['customer-source-data'],
            operation: input.operation,
            processingScopeRef: {
              scopeId: requirementKey,
              scopeType: 'privacy.processing-scope',
            },
            purposeRef: fixtureAuthority,
            purposeVersionId: '1',
            recipientRefs: [],
            subjectRef: {
              moduleId: 'privacy.core',
              resourceId: 'c7000000-0000-4000-8000-000000000001',
              resourceType: 'privacy.core.privacy-subject',
              tenantId,
            },
          },
          outcome: 'ALLOWED',
          policyRevisions: [],
          reasonCodes: [fixtureAuthority],
          trustedDecisionTime: evaluatedAt,
        },
        outcome: 'ALLOWED',
      };
    }),
  );
};
