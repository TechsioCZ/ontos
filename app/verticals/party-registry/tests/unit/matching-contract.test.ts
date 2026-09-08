import { expect, it } from '@app/effect-rstest';

import { Effect } from 'effect';
import { createActionCollector } from '../../../../packages/core-runtime/src/actions/collector.ts';
import { getActionHandler } from '../../../../packages/core-runtime/src/actions/definition.ts';
import { makeDuplicateCandidateCaseRef } from '../../shared/resources/duplicate-candidate-case.ts';
import { makePartyRef } from '../../shared/domain/identity-contracts.ts';
import { evaluateExactClaims, sortClaimKeys } from '../../shared/domain/matching-contracts.ts';
import { tenantClaimLockKeys } from '../../src/services/party-identifier-claim.service.ts';
import { confirmDuplicatePartiesAction } from '../../src/actions/confirm-duplicate-parties.action.ts';
import { dismissDuplicateCandidateAction } from '../../src/actions/dismiss-duplicate-candidate.action.ts';
import { markDuplicateCandidateNeedsEvidenceAction } from '../../src/actions/mark-duplicate-candidate-needs-evidence.action.ts';
import { resolveDuplicateCandidateCreateAction } from '../../src/actions/resolve-duplicate-candidate-create.action.ts';
import { resolveDuplicateCandidateMatchAction } from '../../src/actions/resolve-duplicate-candidate-match.action.ts';

const evidenceTenantId = '10000000-0000-4000-8000-000000000001';
const evidencePayload = {
  caseRef: makeDuplicateCandidateCaseRef(evidenceTenantId, '20000000-0000-4000-8000-000000000001'),
  expectedRevision: 1,
  reason: 'Reviewed evidence',
};
const evidenceScope = {
  authMethod: 'system' as const,
  correlationId: 'review-evidence',
  principalId: '30000000-0000-4000-8000-000000000001',
  tenantId: evidenceTenantId,
};

it.effect(
  'reviewed Create records metadata-only invariant evidence and commits its created event',
  () =>
    Effect.gen(function* reviewedCreateEvidence() {
      const collector = createActionCollector(
        resolveDuplicateCandidateCreateAction.descriptor.domainEvents,
        'party.registry',
        resolveDuplicateCandidateCreateAction.descriptor.accessEvidencePolicy,
      );
      yield* getActionHandler(resolveDuplicateCandidateCreateAction)(evidencePayload, {
        ...collector,
        actionInvocationId: '40000000-0000-4000-8000-000000000001',
        scope: evidenceScope,
        services: {
          resolve: () =>
            Effect.succeed({
              caseRef: evidencePayload.caseRef,
              decisionRef: null,
              lifecycleState: 'RESOLVED',
              outcome: 'CREATE_NEW',
              partyRef: makePartyRef(evidenceTenantId, '50000000-0000-4000-8000-000000000001'),
            }),
        },
      });
      expect(collector.snapshot().dataAccessEvents[0]?.evidenceCaptureMode).toBe('metadata_only');
      expect(collector.snapshot().domainEvents.length).toBe(1);
      expect(collector.snapshot().outboxMessages.length).toBe(1);
    }),
);

it.effect(
  'reviewed duplicate confirmation records safe invariant evidence without executing merge',
  () =>
    Effect.gen(function* confirmationEvidence() {
      const collector = createActionCollector(
        confirmDuplicatePartiesAction.descriptor.domainEvents,
        'party.registry',
        confirmDuplicatePartiesAction.descriptor.accessEvidencePolicy,
      );
      yield* getActionHandler(confirmDuplicatePartiesAction)(evidencePayload, {
        ...collector,
        actionInvocationId: '40000000-0000-4000-8000-000000000001',
        scope: evidenceScope,
        services: {
          resolve: () =>
            Effect.succeed({
              caseRef: evidencePayload.caseRef,
              decisionRef: null,
              lifecycleState: 'RESOLVED',
              outcome: 'CONFIRMED_DUPLICATE_PARTIES',
              partyRef: null,
            }),
        },
      });
      expect(collector.snapshot().dataAccessEvents[0]?.evidenceCaptureMode).toBe('metadata_only');
      expect(collector.snapshot().domainEvents).toEqual([]);
      expect(collector.snapshot().outboxMessages).toEqual([]);
    }),
);

it('claim locks are acquired in one deterministic order', () => {
  expect(
    sortClaimKeys(['CZ_DIC\u0000cz:dic\u0000CZ27074358', 'ICO\u0000cz:ico\u000027074358']),
  ).toEqual(['CZ_DIC\u0000cz:dic\u0000CZ27074358', 'ICO\u0000cz:ico\u000027074358']);
});

it('all Duplicate Candidate resolutions are reviewed, idempotent tenant Actions', () => {
  for (const action of [
    resolveDuplicateCandidateMatchAction,
    resolveDuplicateCandidateCreateAction,
    markDuplicateCandidateNeedsEvidenceAction,
    dismissDuplicateCandidateAction,
    confirmDuplicatePartiesAction,
  ]) {
    expect(action.descriptor.legalEntityScope).toBe('optional');
    expect(action.descriptor.idempotency).toBe('required');
    // SAFETY: these descriptors use a constant permission resolver and never inspect the payload.
    expect(action.descriptor.tenantPermission?.({} as never)).toBe('review_party_identity');
  }
});

it('claim lock identity is tenant-qualified, normalized, sorted, and deduplicated', () => {
  expect(
    tenantClaimLockKeys('tenant-b', [
      {
        identifierType: 'ICO',
        namespace: 'CZ:ICO',
        normalizedValue: '27074358',
        verification: 'VERIFIED',
      },
      {
        identifierType: 'CZ_DIC',
        namespace: 'CZ:DIC',
        normalizedValue: 'CZ27074358',
        verification: 'VERIFIED',
      },
      {
        identifierType: 'ICO',
        namespace: 'CZ:ICO',
        normalizedValue: '27074358',
        verification: 'VERIFIED',
      },
    ]),
  ).toEqual([
    '["tenant-b","CZ_DIC","CZ:DIC","CZ27074358"]',
    '["tenant-b","ICO","CZ:ICO","27074358"]',
  ]);
  expect(
    tenantClaimLockKeys('tenant-a', [
      {
        identifierType: 'ICO',
        namespace: 'CZ:ICO',
        normalizedValue: '27074358',
        verification: 'VERIFIED',
      },
    ]),
  ).not.toEqual(
    tenantClaimLockKeys('tenant-b', [
      {
        identifierType: 'ICO',
        namespace: 'CZ:ICO',
        normalizedValue: '27074358',
        verification: 'VERIFIED',
      },
    ]),
  );
  expect(
    tenantClaimLockKeys('tenant-b', [
      {
        identifierType: 'ICO',
        namespace: 'CZ:ICO',
        normalizedValue: '27074358',
        verification: 'VERIFIED',
      },
    ]).some((key) => key.includes('\u0000')),
  ).toBe(false);
});

it('authoritative exact claims cannot be outvoted by weak evidence', () => {
  expect(evaluateExactClaims([])).toEqual({ outcome: 'NO_MATCH', partyIds: [] });
  expect(evaluateExactClaims(['aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'])).toEqual({
    outcome: 'MATCHED',
    partyIds: ['aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'],
  });
  expect(
    evaluateExactClaims([
      'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
      'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    ]),
  ).toEqual({
    outcome: 'AMBIGUOUS',
    partyIds: ['aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'],
  });
});
