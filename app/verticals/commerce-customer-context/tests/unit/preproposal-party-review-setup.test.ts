import { readFile } from 'node:fs/promises';
import {
  CreatePartyPayloadSchema,
  CounterpartyCustomerOnboardPayloadSchema,
  CounterpartyCustomerOnboardResultSchema,
  PartyCommandUnprocessableProblemSchema,
  CreatePartyResultSchema,
  DuplicateCandidateDetailResponseSchema,
  PartyMatchDecisionResponseSchema,
  ResolveDuplicateCandidateCreateResultSchema,
} from '@app/party-registry/api';
import {
  createPartyWithAuthorization,
  counterpartyCustomerOnboardWithAuthorization,
  executeDuplicateCandidateDetailWithAuthorization,
  executePartyMatchDecisionWithAuthorization,
  resolveDuplicateCandidateCreateWithAuthorization,
} from '@app/party-registry/api/client';
import { Effect, Exit, Redacted, Schema } from 'effect';
import { beforeEach, expect, it, rs } from 'effect-rstest';

import {
  createRegisteredPreproposalParty,
  PreproposalNativeProtocolError,
} from '../support/preproposal-basis-native.ts';

// Unit-only public transport doubles; native setup always uses the real published clients.
rs.mock('@app/party-registry/api/client', () => ({
  counterpartyCustomerOnboardWithAuthorization: rs.fn(),
  createPartyWithAuthorization: rs.fn(),
  executeDuplicateCandidateDetailWithAuthorization: rs.fn(),
  executePartyMatchDecisionWithAuthorization: rs.fn(),
  resolveDuplicateCandidateCreateWithAuthorization: rs.fn(),
}));

const tenantId = '11111111-1111-4111-8111-111111111111';
const reference = (kind: string, resourceId: string) => ({
  moduleId: 'party.registry',
  resourceId,
  resourceType: `party.registry.${kind}`,
  tenantId,
});
const caseRef = reference('duplicate-candidate-case', '22222222-2222-4222-8222-222222222222');
const initialRef = reference('party-match-decision', '33333333-3333-4333-8333-333333333333');
const reviewedRef = reference('party-match-decision', '44444444-4444-4444-8444-444444444444');
const partyRef = reference('party', '55555555-5555-4555-8555-555555555555');
const candidate = {
  displayName: 'Unit-only reviewed human customer',
  evidenceRefs: ['unit-attestation'],
  officialIdentifiers: [],
  partyType: 'PERSON',
  provenance: { method: 'DIRECT_INTERACTION', source: 'unit-only' },
  subjectEvidence: [
    {
      basis: 'DIRECT_INTERACTION',
      evidenceRef: 'unit-attestation',
      kind: 'ACTOR_ATTESTATION',
      observedSubject: 'PERSON',
      statement: 'Operator attests the concrete human subject',
      subjectKey: 'unit-subject',
    },
  ],
  validFrom: '2026-10-24T00:00:00.000Z',
};
const payload = Schema.decodeUnknownSync(CreatePartyPayloadSchema)({ candidate });
const ambiguous = Schema.decodeUnknownSync(CreatePartyResultSchema)({
  caseRef,
  decisionRef: initialRef,
  outcome: 'AMBIGUOUS',
});
const direct = Schema.decodeUnknownSync(CreatePartyResultSchema)({
  decisionRef: initialRef,
  outcome: 'CREATED',
  partyRef,
});
const explanations = [
  { evidenceRefs: candidate.evidenceRefs, reason: 'No exclusive identifier; review required', ruleKey: 'unit-rule' },
];
const detail = Schema.decodeUnknownSync(DuplicateCandidateDetailResponseSchema)({
  candidate,
  candidateParties: [],
  caseRef,
  evaluatedEvidence: explanations,
  lifecycleState: 'OPEN',
  matchRuleVersion: 'unit-rule',
  priorCaseRef: null,
  resolutionOutcome: null,
  resolutionReason: null,
  resolvedAt: null,
  revision: 7,
});
const evidenceEvaluation = {
  evidence: candidate.subjectEvidence,
  reasonCode: 'supported',
  subjectEligibilityVersion: 'party-concrete-subject.v1',
  subjectEligible: true,
  typeRuleVersion: 'party-subject-type.v1',
  typeSupported: true,
};
const originalDecision = Schema.decodeUnknownSync(PartyMatchDecisionResponseSchema)({
  caseRef,
  committedCreateOutcome: 'AMBIGUOUS',
  decidedAt: candidate.validFrom,
  decisionRef: initialRef,
  evidenceEvaluation,
  evidenceExplanation: explanations,
  matchRuleVersion: 'unit-rule',
  operation: 'CREATE',
  outcome: 'AMBIGUOUS',
  partyRef: null,
});
const createdDecision = Schema.decodeUnknownSync(PartyMatchDecisionResponseSchema)({
  ...originalDecision,
  caseRef: null,
  committedCreateOutcome: 'CREATED',
  decisionRef: reviewedRef,
  operation: 'REVIEW_CREATE',
  outcome: 'CREATED',
  partyRef,
});
const review = Schema.decodeUnknownSync(ResolveDuplicateCandidateCreateResultSchema)({
  caseRef,
  decisionRef: reviewedRef,
  lifecycleState: 'RESOLVED',
  outcome: 'CREATE_NEW',
  partyRef,
});
const options = { baseUrl: 'https://party.unit.invalid/party-registry-api', compositionRevision: 'unit-composition' };

beforeEach(() => {
  rs.resetAllMocks();
  rs.mocked(createPartyWithAuthorization).mockReturnValue(Effect.succeed(ambiguous));
  rs.mocked(executeDuplicateCandidateDetailWithAuthorization).mockReturnValue(Effect.succeed(detail));
  rs.mocked(resolveDuplicateCandidateCreateWithAuthorization).mockReturnValue(Effect.succeed(review));
  rs.mocked(executePartyMatchDecisionWithAuthorization)
    .mockReturnValueOnce(Effect.succeed(originalDecision))
    .mockReturnValueOnce(Effect.succeed(createdDecision))
    .mockReturnValueOnce(Effect.succeed(originalDecision));
});

const setup = (legalEntities: boolean[] = []) =>
  createRegisteredPreproposalParty({
    authorize: (legalEntity) =>
      Effect.sync(() => {
        legalEntities.push(legalEntity);
        return Redacted.make(`unit-manager-${legalEntity ? 'le' : 'tenant'}-assertion-${legalEntities.length}`);
      }),
    intent: 'unit-setup',
    options,
    payload,
    tenantId,
  });

it.effect('keeps a direct CREATED result without review or evidence reads', () =>
  Effect.gen(function* directCreated() {
    rs.mocked(createPartyWithAuthorization).mockReturnValue(Effect.succeed(direct));
    const credentials: boolean[] = [];
    const result = yield* setup(credentials);
    expect(result.initialCreate).toBe(direct);
    expect(result.partyRef).toEqual(direct.outcome === 'CREATED' ? direct.partyRef : undefined);
    expect(credentials).toEqual([false]);
    expect(executeDuplicateCandidateDetailWithAuthorization).not.toHaveBeenCalled();
    expect(resolveDuplicateCandidateCreateWithAuthorization).not.toHaveBeenCalled();
    expect(executePartyMatchDecisionWithAuthorization).not.toHaveBeenCalled();
  }),
);

it.effect(
  'uses actual case revision, fresh LE manager assertions, real review decision and unchanged original history',
  () =>
    Effect.gen(function* reviewedCreate() {
      const credentials: boolean[] = [];
      const result = yield* setup(credentials);
      expect(result.initialCreate).toBe(ambiguous);
      expect(result.partyRef).toEqual(createdDecision.partyRef);
      expect(credentials).toEqual([false, true, true, true, true, true]);
      expect(createPartyWithAuthorization).toHaveBeenCalledWith(payload, 'unit-manager-tenant-assertion-1', {
        ...options,
        correlationId: 'unit-setup:party',
        idempotencyKey: 'unit-setup:party',
      });
      expect(executeDuplicateCandidateDetailWithAuthorization).toHaveBeenCalledWith(
        { caseRef: ambiguous.outcome === 'AMBIGUOUS' ? ambiguous.caseRef : undefined },
        'unit-manager-le-assertion-2',
        'unit-setup:party-review-detail',
        options,
      );
      expect(resolveDuplicateCandidateCreateWithAuthorization).toHaveBeenCalledWith(
        {
          caseRef: detail.caseRef,
          expectedRevision: 7,
          reason: expect.stringContaining('original direct-interaction PERSON attestation'),
        },
        'unit-manager-le-assertion-4',
        {
          ...options,
          correlationId: 'unit-setup:party-review-create',
          idempotencyKey: 'unit-setup:party-review-create',
        },
      );
      expect(rs.mocked(executePartyMatchDecisionWithAuthorization).mock.calls.map((args) => args[0])).toEqual([
        { decisionRef: initialRef },
        { decisionRef: reviewedRef },
        { decisionRef: initialRef },
      ]);
      expect(rs.mocked(executePartyMatchDecisionWithAuthorization).mock.calls.map((args) => args[1])).toEqual([
        'unit-manager-le-assertion-3',
        'unit-manager-le-assertion-5',
        'unit-manager-le-assertion-6',
      ]);
    }),
);

it.effect('refuses MATCHED_EXISTING with the actual typed outcome and reason', () =>
  Effect.gen(function* matchedExisting() {
    rs.mocked(createPartyWithAuthorization).mockReturnValue(
      Effect.succeed(
        Schema.decodeUnknownSync(CreatePartyResultSchema)({
          decisionRef: initialRef,
          outcome: 'MATCHED_EXISTING',
          partyRef,
        }),
      ),
    );
    const failure = yield* setup().pipe(
      Effect.flip,
      Effect.flatMap(Schema.decodeUnknownEffect(PreproposalNativeProtocolError)),
    );
    expect(failure.message).toContain('MATCHED_EXISTING');
    expect(failure.message).toContain('matching is not creation');
    expect(resolveDuplicateCandidateCreateWithAuthorization).not.toHaveBeenCalled();
  }),
);

it.effect('refuses a different case candidate before review', () =>
  Effect.gen(function* wrongCandidate() {
    rs.mocked(executeDuplicateCandidateDetailWithAuthorization).mockReturnValue(
      Effect.succeed({ ...detail, candidate: { ...detail.candidate, displayName: 'Another subject' } }),
    );
    const failure = yield* setup().pipe(
      Effect.flip,
      Effect.flatMap(Schema.decodeUnknownEffect(PreproposalNativeProtocolError)),
    );
    expect(failure.message).toContain('originating open case, candidate and evidence');
    expect(resolveDuplicateCandidateCreateWithAuthorization).not.toHaveBeenCalled();
  }),
);

it.effect('refuses a review result tied to another originating case', () =>
  Effect.gen(function* wrongReviewCase() {
    rs.mocked(resolveDuplicateCandidateCreateWithAuthorization).mockReturnValue(
      Effect.succeed({
        ...review,
        caseRef: { ...review.caseRef, resourceId: detail.caseRef.resourceId.replace('2', '6') },
      }),
    );
    const failure = yield* setup().pipe(
      Effect.flip,
      Effect.flatMap(Schema.decodeUnknownEffect(PreproposalNativeProtocolError)),
    );
    expect(failure.message).toContain('originating case and tenant');
  }),
);

it.effect('does not synthesize CREATED from a non-created public review decision', () =>
  Effect.gen(function* wrongDecision() {
    rs.mocked(executePartyMatchDecisionWithAuthorization)
      .mockReset()
      .mockReturnValueOnce(Effect.succeed(originalDecision))
      .mockReturnValueOnce(
        Effect.succeed(
          Schema.decodeUnknownSync(PartyMatchDecisionResponseSchema)({
            ...createdDecision,
            committedCreateOutcome: 'MATCHED_EXISTING',
            outcome: 'MATCHED',
          }),
        ),
      );
    const failure = yield* setup().pipe(
      Effect.flip,
      Effect.flatMap(Schema.decodeUnknownEffect(PreproposalNativeProtocolError)),
    );
    expect(failure.message).toContain('MATCHED');
    expect(failure.message).toContain('literal CREATED');
  }),
);

it.effect('refuses altered original create decision history', () =>
  Effect.gen(function* changedHistory() {
    rs.mocked(executePartyMatchDecisionWithAuthorization)
      .mockReset()
      .mockReturnValueOnce(Effect.succeed(originalDecision))
      .mockReturnValueOnce(Effect.succeed(createdDecision))
      .mockReturnValueOnce(Effect.succeed({ ...originalDecision, matchRuleVersion: 'changed-rule' }));
    const failure = yield* setup().pipe(
      Effect.flip,
      Effect.flatMap(Schema.decodeUnknownEffect(PreproposalNativeProtocolError)),
    );
    expect(failure.message).toContain('original create decision history');
  }),
);

it.effect('keeps review execution authority in manager setup and out of service action keys', () =>
  Effect.gen(function* setupGrantScope() {
    const source = yield* Effect.tryPromise(() =>
      readFile(new URL('../support/preproposal-basis-native.ts', import.meta.url), 'utf-8'),
    );
    const nativeKeys = source.slice(
      source.indexOf('const nativeActionKeys = ['),
      source.indexOf('const identitySetupActionKeys ='),
    );
    expect(nativeKeys).not.toContain('party.registry.resolve-duplicate-candidate-create');
    expect(source).toContain("const partySetupActionKeys = ['party.registry.resolve-duplicate-candidate-create']");
    expect(source).toContain('actionKeys: [...nativeActionKeys, ...identitySetupActionKeys, ...partySetupActionKeys]');
    expect(source).toContain('actionKeys: nativeActionKeys');
    expect(source).toContain('authorize: (legalEntity) => signBuyer(partyAudience, legalEntity, false)');
  }),
);

for (const missing of ['partyRef', 'decisionRef']) {
  it.effect(`refuses a review without its ${missing} proof`, () =>
    Effect.gen(function* absentReviewProof() {
      rs.mocked(resolveDuplicateCandidateCreateWithAuthorization).mockReturnValue(
        Effect.succeed(
          Schema.decodeUnknownSync(ResolveDuplicateCandidateCreateResultSchema)({ ...review, [missing]: null }),
        ),
      );
      const failure = yield* setup().pipe(
        Effect.flip,
        Effect.flatMap(Schema.decodeUnknownEffect(PreproposalNativeProtocolError)),
      );
      expect(failure.message).toContain('CREATE_NEW');
      expect(failure.message).toContain('Review must create a new Party and decision');
    }),
  );
}

const approvedOnboarding = Schema.decodeUnknownSync(CounterpartyCustomerOnboardPayloadSchema)({
  counterpartyProvenance: {
    evidenceReference: 'unit:commercial-approval',
    method: 'APPROVED_COMMERCIAL_RELATIONSHIP',
    reason: 'Operator approves this isolated commercial relationship with the selling Legal Entity',
    source: 'NATIVE_REGISTERED_OWNER_PROOF',
  },
  customerEvidence: {
    evidenceReference: 'unit:customer-approval',
    method: 'APPROVED_PURCHASING_RELATIONSHIP',
    reason: 'Operator approves this isolated CUSTOMER purchasing relationship',
    source: 'NATIVE_REGISTERED_OWNER_PROOF',
  },
  partyRef,
  validFrom: candidate.validFrom,
});
const onboardingRefusal = Schema.decodeUnknownSync(PartyCommandUnprocessableProblemSchema)({
  _tag: 'PartyCommandUnprocessableProblem',
  code: 'counterparty_evidence_insufficient',
  detail: 'The evidence does not establish both a commercial context and a CUSTOMER relationship',
  status: 422,
  title: 'Counterparty evidence insufficient',
  type: 'https://unit.invalid/problems/counterparty-evidence-insufficient',
});
const onboardingResult = Schema.decodeUnknownSync(CounterpartyCustomerOnboardResultSchema)({
  counterpartyCreated: true,
  counterpartyRef: reference('counterparty', '66666666-6666-4666-8666-666666666666'),
  legalEntityRef: {
    moduleId: 'core.identity',
    resourceId: '77777777-7777-4777-8777-777777777777',
    resourceType: 'core.identity.legal-entity',
    tenantId,
  },
  partyRef,
  rolePeriodCreated: true,
  rolePeriodRef: reference('counterparty-role-period', '88888888-8888-4888-8888-888888888888'),
  roleType: 'CUSTOMER',
  validFrom: candidate.validFrom,
  validTo: null,
});
// Unit-only public transport control for the actual26 refusal and the two fixture approval inputs.
// It is not a substitute for running the owner's predicate or a native eligibility proof.
const mockRelationshipApprovalTransport = () =>
  rs
    .mocked(counterpartyCustomerOnboardWithAuthorization)
    .mockImplementation((input) =>
      input.counterpartyProvenance.method === 'APPROVED_COMMERCIAL_RELATIONSHIP' &&
      input.customerEvidence.method === 'APPROVED_PURCHASING_RELATIONSHIP'
        ? Effect.succeed(onboardingResult)
        : Effect.fail(onboardingRefusal),
    );

it.effect('the native onboarding caller supplies separate explicit commercial and CUSTOMER approvals', () =>
  Effect.gen(function* nativeApprovalPayload() {
    mockRelationshipApprovalTransport();
    const source = yield* Effect.tryPromise(() =>
      readFile(new URL('../support/preproposal-basis-native.ts', import.meta.url), 'utf-8'),
    );
    const block = source.slice(
      source.indexOf('    const onboardPayload ='),
      source.indexOf('    const counterparty ='),
    );
    // Read the actual source-caller inputs without evaluating the private fixture or owner code.
    const input = yield* Schema.decodeUnknownEffect(CounterpartyCustomerOnboardPayloadSchema)({
      ...approvedOnboarding,
      counterpartyProvenance: {
        ...approvedOnboarding.counterpartyProvenance,
        method: /counterpartyProvenance:\s*\{[\s\S]*?method: '(?<method>[^']+)'/u.exec(block)?.[1],
        reason: /counterpartyProvenance:\s*\{[\s\S]*?reason: '(?<reason>[^']+)'/u.exec(block)?.[1],
      },
      customerEvidence: {
        ...approvedOnboarding.customerEvidence,
        method: /customerEvidence:\s*\{[\s\S]*?method: '(?<method>[^']+)'/u.exec(block)?.[1],
        reason: /customerEvidence:\s*\{[\s\S]*?reason: '(?<reason>[^']+)'/u.exec(block)?.[1],
      },
    });
    const result = yield* counterpartyCustomerOnboardWithAuthorization(input, 'unit-manager-le-onboarding', {
      ...options,
      correlationId: 'unit:customer',
      idempotencyKey: 'unit:customer',
    }).pipe(Effect.exit);
    expect(result).toEqual(Exit.succeed(onboardingResult));
    expect(input.counterpartyProvenance.method).toBe('APPROVED_COMMERCIAL_RELATIONSHIP');
    expect(input.customerEvidence.method).toBe('APPROVED_PURCHASING_RELATIONSHIP');
    expect(input.counterpartyProvenance.reason).toContain('Operator approves this isolated commercial relationship');
    expect(input.customerEvidence.reason).toContain('Operator approves this isolated CUSTOMER purchasing relationship');
    expect(input.counterpartyProvenance.evidenceReference).not.toBe(input.customerEvidence.evidenceReference);
  }),
);

for (const field of ['counterpartyProvenance', 'customerEvidence']) {
  it.effect(`unit public transport preserves typed422 for unsupported ${field}`, () =>
    Effect.gen(function* unapprovedRelationship() {
      mockRelationshipApprovalTransport();
      const input = yield* Schema.decodeUnknownEffect(CounterpartyCustomerOnboardPayloadSchema)({
        ...approvedOnboarding,
        [field]: {
          ...(field === 'counterpartyProvenance'
            ? approvedOnboarding.counterpartyProvenance
            : approvedOnboarding.customerEvidence),
          method: 'OPERATOR_ATTESTATION',
        },
      });
      const refused = yield* counterpartyCustomerOnboardWithAuthorization(input, 'unit-manager-le-onboarding', {
        ...options,
        correlationId: 'unit:rejected-customer',
        idempotencyKey: 'unit:rejected-customer',
      }).pipe(Effect.flip, Effect.flatMap(Schema.decodeUnknownEffect(PartyCommandUnprocessableProblemSchema)));
      expect(refused.code).toBe('counterparty_evidence_insufficient');
      expect(refused.status).toBe(422);
      expect(refused.detail).toBe(onboardingRefusal.detail);
    }),
  );
}

it.effect('grants only the actual onboarded Counterparty to the CCC reader before profile creation', () =>
  Effect.gen(function* nativeCounterpartyReaderSetup() {
    const source = yield* Effect.tryPromise(() =>
      readFile(new URL('../support/preproposal-basis-native.ts', import.meta.url), 'utf-8'),
    );
    const onboardStart = source.indexOf(
      '    const counterparty = yield* counterpartyCustomerOnboardWithAuthorization(',
    );
    const profileCredential = source.indexOf(
      "    const profileCredential = yield* authorize('operator', contextAudience);",
      onboardStart,
    );
    const profileCreate = source.indexOf(
      '    const profile = yield* executeCreateCounterpartyPurchasingProfileWithAuthorization(',
      profileCredential,
    );
    // CCC's preproposal identity is the Pricing issuer, so both service identities read the onboarded Counterparty.
    const grant =
      "    yield* core.grantResourceAccess(counterparty.counterpartyRef, identities.cccReader.principalId, 'reader');\n" +
      "    yield* core.grantResourceAccess(counterparty.counterpartyRef, identities.pricingIssuer.principalId, 'reader');";
    const grantPosition = source.indexOf(grant);
    expect(onboardStart).toBeGreaterThanOrEqual(0);
    expect(grantPosition).toBeGreaterThan(onboardStart);
    expect(profileCredential).toBeGreaterThan(grantPosition);
    expect(profileCreate).toBeGreaterThan(profileCredential);
    expect(source.slice(onboardStart, profileCredential).trimEnd().endsWith(grant.trim())).toBe(true);
    expect(source.slice(onboardStart, profileCredential).match(/core\.grantResourceAccess\(/gu)).toHaveLength(2);
  }),
);
