import { expect, it } from 'effect-rstest';
import { Effect, Schema } from 'effect';
import { createActionCollector } from '../../../../packages/core-runtime/src/actions/collector.ts';
import { getActionHandler } from '../../../../packages/core-runtime/src/actions/definition.ts';
import {
  ProfileReconciliationOwnerVerifier,
  profileReconciliationOwnerVerifierUnavailable,
  resolveProfileReconciliationAction,
  ResolveProfileReconciliationPayloadSchema,
  ResolveProfileReconciliationResultSchema,
} from '../../src/actions/resolve-profile-reconciliation.action.ts';
import { RECONCILIATION_REQUIRED_OWNERS } from '../../shared/domain/profile-contracts.ts';
import type { ReconciliationOwnerOutcome } from '../../shared/domain/profile-contracts.ts';

const tenantId = '11111111-1111-4111-8111-111111111111';
const payload = Schema.decodeUnknownSync(ResolveProfileReconciliationPayloadSchema)({
  caseRef: {
    moduleId: 'commerce.customer-context',
    resourceId: 'reconciliation-case-1',
    resourceType: 'commerce.customer-context.profile-reconciliation-case',
    tenantId,
  },
  effectiveAt: '2026-09-09T12:00:00.000Z',
  expectedEventVersion: '3',
  expectedRevision: 1,
  ownerOutcomes: RECONCILIATION_REQUIRED_OWNERS.map((owner) => ({
    owner,
    status: 'RESOLVED',
  })),
  reason: 'Resolve an explicit Party merge collision',
  resultingState: 'ACTIVE',
  survivorProfileRef: {
    kind: 'RETAIL',
    moduleId: 'commerce.customer-context',
    resourceId: 'retail-profile-1',
    resourceType: 'commerce.customer-context.retail-customer-profile',
    tenantId,
  },
});

const pendingOwnerOutcomes = RECONCILIATION_REQUIRED_OWNERS.map((owner) => ({
  owner,
  status: 'PENDING' as const,
}));

const scope = {
  authMethod: 'system' as const,
  correlationId: 'resolve-reconciliation',
  legalEntityId: '22222222-2222-4222-8222-222222222222',
  principalId: '33333333-3333-4333-8333-333333333333',
  tenantId,
};

it.effect(
  'accepts evidence only from trusted owner verifiers and preserves conflicts as partial progress',
  () =>
    Effect.gen(function* fabricatedOwnerEvidence() {
      const [firstOwnerOutcome] = payload.ownerOutcomes;
      expect(firstOwnerOutcome).toBeDefined();
      if (firstOwnerOutcome !== undefined) {
        expect('evidenceRef' in firstOwnerOutcome).toBe(false);
      }
      const collector = createActionCollector(
        resolveProfileReconciliationAction.descriptor.domainEvents,
        'commerce.customer-context',
        resolveProfileReconciliationAction.descriptor.accessEvidencePolicy,
        resolveProfileReconciliationAction.descriptor.auditEvidenceSchema,
      );
      const recordedOwners: string[] = [];
      const result = yield* getActionHandler(resolveProfileReconciliationAction)(payload, {
        actionInvocationId: '44444444-4444-4444-8444-444444444444',
        addDomainEvent: collector.addDomainEvent,
        addOutboxMessage: collector.addOutboxMessage,
        recordAuditEvidence: collector.recordAuditEvidence,
        recordDataAccess: collector.recordDataAccess,
        scope,
        services: {
          ownerReconciler: {
            finalize: (requested, expectedCaseRevision, unavailableOwners, conflictingOwners) =>
              Effect.succeed({
                caseRef: requested.caseRef,
                conflictingOwners,
                lastProcessedEventVersion: requested.expectedEventVersion,
                outcome: 'RECONCILIATION_PROGRESS_RECORDED' as const,
                ownerOutcomes: pendingOwnerOutcomes,
                revision: expectedCaseRevision,
                state: 'BLOCKED' as const,
                unavailableOwners,
              }),
            load: (caseRef) =>
              Effect.succeed({
                caseRef,
                lastProcessedEventVersion: payload.expectedEventVersion,
                ownerOutcomes: pendingOwnerOutcomes,
                revision: payload.expectedRevision,
                state: 'OPEN' as const,
              }),
            record: (request) => {
              recordedOwners.push(request.durableOutcome.owner);
              return Effect.succeed({
                caseRef: request.caseRef,
                lastProcessedEventVersion: request.expectedEventVersion,
                ownerOutcomes: pendingOwnerOutcomes.map((outcome) =>
                  outcome.owner === request.durableOutcome.owner ? request.durableOutcome : outcome,
                ),
                revision: request.expectedCaseRevision + 1,
                state: 'OPEN' as const,
              });
            },
          },
          ownerVerifier: {
            verify: (request) =>
              Effect.succeed(
                request.desiredOutcome.owner === 'PROFILE_LIFECYCLE'
                  ? {
                      _tag: 'CONFLICT' as const,
                      owner: request.desiredOutcome.owner,
                      reason: 'Lifecycle resolution receipt is absent',
                    }
                  : {
                      _tag: 'VERIFIED' as const,
                      correlationRef: `verification:${request.desiredOutcome.owner}`,
                      durableOutcome: {
                        ...request.desiredOutcome,
                        evidenceRef: `trusted-proof:${request.desiredOutcome.owner}`,
                      },
                    },
              ),
          },
        },
      }).pipe(
        Effect.provideService(
          ProfileReconciliationOwnerVerifier,
          profileReconciliationOwnerVerifierUnavailable,
        ),
      );

      expect(Schema.is(ResolveProfileReconciliationResultSchema)(result)).toBe(true);
      if (
        Schema.is(ResolveProfileReconciliationResultSchema)(result) &&
        result.outcome === 'RECONCILIATION_PROGRESS_RECORDED'
      ) {
        expect(result.conflictingOwners).toEqual(['PROFILE_LIFECYCLE']);
        expect(result.state).toBe('BLOCKED');
      }
      expect(recordedOwners).not.toContain('PROFILE_LIFECYCLE');
      expect(recordedOwners).toHaveLength(RECONCILIATION_REQUIRED_OWNERS.length - 1);
      expect(collector.snapshot().domainEvents).toHaveLength(0);
      expect(collector.snapshot().outboxMessages).toHaveLength(0);
    }),
);

it.effect('resumes from durable terminal outcomes without replacing their attribution', () =>
  Effect.gen(function* retryFromDurableProgress() {
    const collector = createActionCollector(
      resolveProfileReconciliationAction.descriptor.domainEvents,
      'commerce.customer-context',
      resolveProfileReconciliationAction.descriptor.accessEvidencePolicy,
      resolveProfileReconciliationAction.descriptor.auditEvidenceSchema,
    );
    const verifiedOwners: string[] = [];
    const recordedOwners: string[] = [];
    let revision = payload.expectedRevision + 2;
    let durableOwnerOutcomes: ReconciliationOwnerOutcome[] = pendingOwnerOutcomes.map(
      (outcome, index) =>
        index < 2
          ? {
              evidenceRef: `original-owner-proof:${outcome.owner}`,
              owner: outcome.owner,
              status: 'RESOLVED' as const,
            }
          : outcome,
    );
    const result = yield* getActionHandler(resolveProfileReconciliationAction)(payload, {
      actionInvocationId: '55555555-5555-4555-8555-555555555555',
      addDomainEvent: collector.addDomainEvent,
      addOutboxMessage: collector.addOutboxMessage,
      recordAuditEvidence: collector.recordAuditEvidence,
      recordDataAccess: collector.recordDataAccess,
      scope,
      services: {
        ownerReconciler: {
          finalize: (requested, expectedCaseRevision, unavailableOwners, conflictingOwners) =>
            Effect.succeed({
              caseRef: requested.caseRef,
              conflictingOwners,
              lastProcessedEventVersion: requested.expectedEventVersion,
              outcome: 'RECONCILIATION_PROGRESS_RECORDED' as const,
              ownerOutcomes: durableOwnerOutcomes,
              revision: expectedCaseRevision,
              state: 'BLOCKED' as const,
              unavailableOwners,
            }),
          load: (caseRef) =>
            Effect.succeed({
              caseRef,
              lastProcessedEventVersion: payload.expectedEventVersion,
              ownerOutcomes: durableOwnerOutcomes,
              revision,
              state: 'OPEN' as const,
            }),
          record: (request) => {
            recordedOwners.push(request.durableOutcome.owner);
            revision += 1;
            durableOwnerOutcomes = durableOwnerOutcomes.map((outcome) =>
              outcome.owner === request.durableOutcome.owner ? request.durableOutcome : outcome,
            );
            return Effect.succeed({
              caseRef: request.caseRef,
              lastProcessedEventVersion: request.expectedEventVersion,
              ownerOutcomes: durableOwnerOutcomes,
              revision,
              state: 'OPEN' as const,
            });
          },
        },
        ownerVerifier: {
          verify: (request) => {
            verifiedOwners.push(request.desiredOutcome.owner);
            return Effect.succeed(
              request.desiredOutcome.owner === 'PRICE_GROUP_ASSIGNMENT'
                ? {
                    _tag: 'CONFLICT' as const,
                    owner: request.desiredOutcome.owner,
                    reason: 'A price assignment reconciliation receipt is absent',
                  }
                : {
                    _tag: 'VERIFIED' as const,
                    correlationRef: `retry-verification:${request.desiredOutcome.owner}`,
                    durableOutcome: {
                      ...request.desiredOutcome,
                      evidenceRef: `retry-proof:${request.desiredOutcome.owner}`,
                    },
                  },
            );
          },
        },
      },
    }).pipe(
      Effect.provideService(
        ProfileReconciliationOwnerVerifier,
        profileReconciliationOwnerVerifierUnavailable,
      ),
    );

    expect(Schema.is(ResolveProfileReconciliationResultSchema)(result)).toBe(true);
    expect(verifiedOwners).not.toContain(RECONCILIATION_REQUIRED_OWNERS[0]);
    expect(verifiedOwners).not.toContain(RECONCILIATION_REQUIRED_OWNERS[1]);
    expect(recordedOwners).not.toContain(RECONCILIATION_REQUIRED_OWNERS[0]);
    expect(recordedOwners).not.toContain(RECONCILIATION_REQUIRED_OWNERS[1]);
    expect(durableOwnerOutcomes[0]).toMatchObject({
      evidenceRef: `original-owner-proof:${RECONCILIATION_REQUIRED_OWNERS[0]}`,
    });
    expect(durableOwnerOutcomes[1]).toMatchObject({
      evidenceRef: `original-owner-proof:${RECONCILIATION_REQUIRED_OWNERS[1]}`,
    });
  }),
);
