import { Effect, Schema } from 'effect';
import { expect, it } from 'effect-rstest';

import { createActionCollector } from '../../../../packages/core-runtime/src/actions/collector.ts';
import { getActionHandler } from '../../../../packages/core-runtime/src/actions/definition.ts';
import { PrincipalIdSchema, TenantIdSchema } from '@app/core-runtime/auth/external-identity-contracts';
import { makePartyRef, PartySubjectEvidenceSchema } from '../../shared/domain/identity-contracts.ts';
import {
  PartyMatchDecisionRecordSchema,
  committedCreateResult,
  evaluateExactClaims,
  sortClaimKeys,
} from '../../shared/domain/matching-contracts.ts';
import { makeDuplicateCandidateCaseRef } from '../../shared/resources/duplicate-candidate-case.ts';
import { makePartyMatchDecisionRef } from '../../shared/resources/party-match-decision.ts';
import { confirmDuplicatePartiesAction } from '../../src/actions/confirm-duplicate-parties.action.ts';
import { dismissDuplicateCandidateAction } from '../../src/actions/dismiss-duplicate-candidate.action.ts';
import { markDuplicateCandidateNeedsEvidenceAction } from '../../src/actions/mark-duplicate-candidate-needs-evidence.action.ts';
import { resolveDuplicateCandidateCreateAction } from '../../src/actions/resolve-duplicate-candidate-create.action.ts';
import { resolveDuplicateCandidateMatchAction } from '../../src/actions/resolve-duplicate-candidate-match.action.ts';
import { partyGuestBindingFailure } from '../../src/policies/create-party-without-strong-identifier.policy.ts';
import { tenantClaimLockKeys } from '../../src/services/party-identifier-claim.service.ts';

const evidenceTenantId = Schema.decodeSync(TenantIdSchema)('10000000-0000-4000-8000-000000000001');
const evidencePrincipalId = Schema.decodeSync(PrincipalIdSchema)('30000000-0000-4000-8000-000000000001');
const evidencePayload = {
  caseRef: makeDuplicateCandidateCaseRef(evidenceTenantId, '20000000-0000-4000-8000-000000000001'),
  expectedRevision: 1,
  reason: 'Reviewed evidence',
};
const evidenceScope = {
  authMethod: 'system' as const,
  correlationId: 'review-evidence',
  principalId: evidencePrincipalId,
  tenantId: evidenceTenantId,
};

it.effect('reviewed Create records metadata-only invariant evidence and commits its created event', () =>
  Effect.gen(function* reviewedCreateEvidence() {
    const collector = createActionCollector(
      resolveDuplicateCandidateCreateAction.descriptor.domainEvents,
      'party.registry',
      resolveDuplicateCandidateCreateAction.descriptor.accessEvidencePolicy,
    );
    yield* getActionHandler(resolveDuplicateCandidateCreateAction)(evidencePayload, {
      ...collector,
      actionInvocationId: '40000000-0000-4000-8000-000000000001',
      compositionRevision: 'a'.repeat(64),
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

it.effect('reviewed duplicate confirmation records safe invariant evidence without executing merge', () =>
  Effect.gen(function* confirmationEvidence() {
    const collector = createActionCollector(
      confirmDuplicatePartiesAction.descriptor.domainEvents,
      'party.registry',
      confirmDuplicatePartiesAction.descriptor.accessEvidencePolicy,
    );
    yield* getActionHandler(confirmDuplicatePartiesAction)(evidencePayload, {
      ...collector,
      actionInvocationId: '40000000-0000-4000-8000-000000000001',
      compositionRevision: 'a'.repeat(64),
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
  expect(sortClaimKeys(['CZ_DIC\u0000cz:dic\u0000CZ27074358', 'ICO\u0000cz:ico\u000027074358'])).toEqual([
    'CZ_DIC\u0000cz:dic\u0000CZ27074358',
    'ICO\u0000cz:ico\u000027074358',
  ]);
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
  ).toEqual(['["tenant-b","CZ_DIC","CZ:DIC","CZ27074358"]', '["tenant-b","ICO","CZ:ICO","27074358"]']);
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
  expect(evaluateExactClaims([])).toEqual({
    outcome: 'NO_MATCH',
    partyIds: [],
  });
  expect(evaluateExactClaims(['aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'])).toEqual({
    outcome: 'MATCHED',
    partyIds: ['aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'],
  });
  expect(evaluateExactClaims(['bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'])).toEqual(
    {
      outcome: 'AMBIGUOUS',
      partyIds: ['aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'],
    },
  );
});

it('review provenance is additive evidence and never a second MATCHED result reference', () => {
  const reviewedCaseRef = evidencePayload.caseRef;
  const record = {
    caseRef: null,
    committedCreateOutcome: 'MATCHED_EXISTING',
    decidedAt: '2026-01-01T00:00:00.000Z',
    decisionRef: makePartyMatchDecisionRef(evidenceTenantId, '40000000-0000-4000-8000-000000000001'),
    evidenceEvaluation: null,
    evidenceExplanation: [{ reason: 'Unchanged reviewed match', ruleKey: 'party-exact-claims.v1' }],
    matchRuleVersion: 'party-exact-claims.v1',
    operation: 'CREATE',
    outcome: 'MATCHED',
    partyRef: makePartyRef(evidenceTenantId, '50000000-0000-4000-8000-000000000001'),
  };
  const decode = Schema.decodeUnknownSync(PartyMatchDecisionRecordSchema);
  expect(decode(record).caseRef).toBe(null);
  const withProvenance = {
    ...record,
    evidenceExplanation: record.evidenceExplanation.map((item) => ({ ...item, reviewedCaseRef })),
  };
  const decoded = decode(withProvenance);
  expect(Schema.encodeSync(PartyMatchDecisionRecordSchema)(decoded)).toEqual(withProvenance);
  expect(committedCreateResult(decoded)).toMatchObject({ outcome: 'MATCHED_EXISTING', partyRef: record.partyRef });
  expect(() => decode({ ...withProvenance, caseRef: reviewedCaseRef })).toThrow();
  expect(() =>
    decode({
      ...withProvenance,
      evidenceExplanation: [
        {
          ...withProvenance.evidenceExplanation[0],
          reviewedCaseRef: { ...reviewedCaseRef, resourceType: 'party.registry.party' },
        },
      ],
    }),
  ).toThrow();
});

it('unchanged decision algebra accepts only the result references for each outcome', () => {
  const partyRef = makePartyRef(evidenceTenantId, '50000000-0000-4000-8000-000000000001');
  const { caseRef } = evidencePayload;
  const base = {
    committedCreateOutcome: null,
    decidedAt: '2026-01-01T00:00:00.000Z',
    decisionRef: makePartyMatchDecisionRef(evidenceTenantId, '40000000-0000-4000-8000-000000000001'),
    evidenceEvaluation: null,
    evidenceExplanation: [{ reason: 'Existing evidence without review provenance', ruleKey: 'party-exact-claims.v1' }],
    matchRuleVersion: 'party-exact-claims.v1',
    operation: 'MATCH',
  };
  const decode = Schema.decodeUnknownSync(PartyMatchDecisionRecordSchema);
  for (const outcome of ['CREATED', 'MATCHED', 'AMBIGUOUS', 'NO_MATCH'] as const) {
    const expectedParty = outcome === 'CREATED' || outcome === 'MATCHED' ? partyRef : null;
    const expectedCase = outcome === 'AMBIGUOUS' ? caseRef : null;
    const record = {
      ...base,
      committedCreateOutcome: outcome === 'CREATED' ? 'CREATED' : null,
      operation: outcome === 'CREATED' ? 'CREATE' : 'MATCH',
      outcome,
      partyRef: expectedParty,
      caseRef: expectedCase,
    };
    expect(decode(record)).toEqual(record);
    expect(() => decode({ ...record, partyRef: expectedParty === null ? partyRef : null })).toThrow();
    expect(() => decode({ ...record, caseRef: expectedCase === null ? caseRef : null })).toThrow();
  }
});

it('retains the exact optional Guest binding on an authorized actor attestation', () => {
  const attestation = {
    basis: 'DIRECT_INTERACTION',
    evidenceRef: 'guest-proof',
    guestBinding: {
      correlationRoot: 'purchase-1241',
      legalEntityRef: {
        moduleId: 'core.identity',
        resourceId: '70000000-0000-4000-8000-000000000001',
        resourceType: 'core.identity.legal-entity',
        tenantId: evidenceTenantId,
      },
    },
    kind: 'ACTOR_ATTESTATION',
    observedSubject: 'PERSON',
    statement: 'I attest this exact Guest purchase concerns this subject',
    subjectKey: 'one-subject',
  };
  const decoded = Schema.decodeUnknownSync(PartySubjectEvidenceSchema)(attestation);
  expect(Schema.encodeSync(PartySubjectEvidenceSchema)(decoded)).toEqual(attestation);
});

it('Guest-bound attestations require one currently trusted selected LE without changing tenant-only evidence', () => {
  const guestBinding = {
    correlationRoot: 'purchase-1241',
    legalEntityRef: {
      moduleId: 'core.identity' as const,
      resourceId: '70000000-0000-4000-8000-000000000001',
      resourceType: 'core.identity.legal-entity' as const,
      tenantId: evidenceTenantId,
    },
  };
  const unbound = Schema.decodeUnknownSync(PartySubjectEvidenceSchema)({
    basis: 'DIRECT_INTERACTION',
    evidenceRef: 'guest-proof',
    kind: 'ACTOR_ATTESTATION',
    observedSubject: 'PERSON',
    statement: 'I met this subject',
    subjectKey: 'one-subject',
  });
  const bound = { ...unbound, guestBinding };
  const scope = { legalEntityId: guestBinding.legalEntityRef.resourceId, tenantId: evidenceTenantId };
  expect(partyGuestBindingFailure({ subjectEvidence: [unbound] }, { tenantId: evidenceTenantId })).toBeUndefined();
  expect(partyGuestBindingFailure({ subjectEvidence: [bound] }, scope)).toBeUndefined();
  for (const invalidScope of [
    { tenantId: evidenceTenantId },
    { ...scope, legalEntityId: '80000000-0000-4000-8000-000000000001' },
    { ...scope, tenantId: '90000000-0000-4000-8000-000000000001' },
  ]) {
    expect(partyGuestBindingFailure({ subjectEvidence: [bound] }, invalidScope)).toBe(
      'guest_binding_requires_trusted_legal_entity',
    );
  }
  expect(partyGuestBindingFailure({ subjectEvidence: [bound, unbound] }, scope)).toBe(
    'guest_binding_requires_one_exact_context',
  );
  expect(
    partyGuestBindingFailure(
      { subjectEvidence: [bound, { ...bound, guestBinding: { ...guestBinding, correlationRoot: 'different' } }] },
      scope,
    ),
  ).toBe('guest_binding_requires_one_exact_context');
  expect(
    Schema.is(PartySubjectEvidenceSchema)({ ...bound, guestBinding: { ...guestBinding, correlationRoot: '' } }),
  ).toBe(false);
  expect(
    Schema.is(PartySubjectEvidenceSchema)({
      ...bound,
      guestBinding: {
        ...guestBinding,
        legalEntityRef: { ...guestBinding.legalEntityRef, resourceType: 'party.registry.party' },
      },
    }),
  ).toBe(false);
});
