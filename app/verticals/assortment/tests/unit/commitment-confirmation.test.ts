import { expect, it } from 'effect-rstest';
import { DateTime, Effect, Exit, Schema } from 'effect';

import {
  assortmentCommitmentConfirmationMatchesExactScope,
  AssortmentCommitmentConfirmationPayloadSchema,
  AssortmentCommitmentConfirmationResultSchema,
  isAssortmentCommitmentConfirmationValidAt,
} from '../../shared/domain/commitment-confirmation.ts';
import {
  AssortmentCandidateSchema,
  AssortmentOwnerResourceRefSchema,
  AssortmentPurchaseConstituentSchema,
  AssortmentSetCompletenessEvidenceSchema,
} from '../../shared/domain/decision-contracts.ts';
import type { AssortmentCandidate } from '../../shared/domain/decision-contracts.ts';
import type { AssortmentCommitmentConfirmationResult } from '../../shared/domain/commitment-confirmation.ts';
import { AssortmentSuccessfulAttemptDecisionEvidenceSchema } from '../../shared/domain/decision-evidence.ts';
import { AssortmentOrdinaryResolutionInputSchema } from '../../shared/domain/ordinary-resolution.ts';
import {
  makeAssortmentCommitmentConfirmationService,
  validateAssortmentCommitmentConfirmation,
} from '../../src/services/assortment-commitment-confirmation.service.ts';
import type {
  AssortmentCommitmentConfirmationEvaluationPort,
  AssortmentCommitmentConfirmationRepository,
} from '../../src/services/assortment-commitment-confirmation.service.ts';

const tenantId = '018f8b4e-35a2-7b51-8d56-91a4f37d6a11';
const ref = (moduleId: string, resourceType: string, resourceId: string, nextTenantId = tenantId) =>
  Schema.decodeUnknownSync(AssortmentOwnerResourceRefSchema)({
    moduleId,
    resourceId,
    resourceType,
    tenantId: nextTenantId,
  });

// Future consumer owners define these types; Assortment treats both references as opaque.
const attemptRef = ref('example.consumer', 'example.consumer.attempt', 'attempt-1');
const meaningRef = ref('example.consumer', 'example.consumer.prospective-purchase-meaning', 'meaning-1');
const productRef = ref('catalog.owner', 'catalog.product', 'product-1');
const variantRef = ref('catalog.owner', 'catalog.variant', 'variant-1');
const candidate = Schema.decodeUnknownSync(AssortmentCandidateSchema)({
  audience: { kind: 'SHARED' },
  bindingRef: ref('commerce.assortment', 'commerce.assortment.applicability-binding', 'binding-1'),
  commercialScope: {
    channelRef: ref('commerce.channel', 'commerce.channel.channel', 'web'),
    sellingLegalEntityRef: ref('commerce.legal-entity', 'commerce.legal-entity.selling-legal-entity', 'sle-1'),
  },
  decisionPurpose: 'PURCHASE',
  effect: 'ALLOW',
  ruleRevision: {
    ownerModuleId: 'commerce.assortment',
    revision: 'r1',
    sourceRef: ref('commerce.assortment', 'commerce.assortment.rule-revision', 'revision-1'),
  },
  selector: { kind: 'VARIANT', variantRef },
  stableRuleRef: ref('commerce.assortment', 'commerce.assortment.stable-rule', 'rule-1'),
});
const constituent = Schema.decodeUnknownSync(AssortmentPurchaseConstituentSchema)({
  catalogSelection: { configuration: { kind: 'NONE' }, productRef, variantKind: 'ATOMIC', variantRef },
  role: 'TOP_LEVEL',
});
const decisionEvidenceRef = {
  evidenceRef: ref('commerce.assortment', 'commerce.assortment.decision-evidence', 'evidence-1'),
  ownerModuleId: 'commerce.assortment',
};
const payload = Schema.decodeUnknownSync(AssortmentCommitmentConfirmationPayloadSchema)({
  attemptRef,
  candidate,
  constituent,
  decisionEvidenceRef,
  prospectivePurchaseMeaningRef: meaningRef,
});
const issuedAt = Schema.decodeUnknownSync(Schema.DateTimeUtcFromString)('2026-09-24T10:00:00.000Z');
const expiresAt = Schema.decodeUnknownSync(Schema.DateTimeUtcFromString)('2026-09-24T10:00:30.000Z');
const confirmation = Schema.decodeUnknownSync(AssortmentCommitmentConfirmationResultSchema)({
  ...payload,
  confirmationRef: ref('commerce.assortment', 'commerce.assortment.commitment-confirmation', 'confirmation-1'),
  expiresAt: '2026-09-24T10:00:30.000Z',
  issuedAt: '2026-09-24T10:00:00.000Z',
});

const confirmationScope = {
  authMethod: 'session' as const,
  correlationId: 'confirmation-correlation',
  legalEntityId: 'sle-1',
  principalId: 'principal-1',
  tenantId,
};

const makeAuthoritativeEvaluation = (
  stale = false,
  candidateSet?: readonly AssortmentCandidate[],
): AssortmentCommitmentConfirmationEvaluationPort => ({
  evaluate: (requestedPayload, _scope, now) => {
    const candidates = candidateSet ?? [requestedPayload.candidate];
    const operationTime = DateTime.formatIso(now);
    const subject = {
      guestEvidence: {
        evidenceRef: ref('commerce.gateway', 'commerce.gateway.guest-evidence', 'guest-1'),
        ownerModuleId: 'commerce.gateway',
      },
      kind: 'GUEST_PURCHASE_CONTEXT' as const,
    };
    const trustedContext = {
      channelRef: ref('commerce.channel', 'commerce.channel.channel', 'web'),
      operationTime,
      sellingLegalEntityRef: ref('commerce.legal-entity', 'commerce.legal-entity.selling-legal-entity', 'sle-1'),
      tenantId,
    };
    const commercialScope = {
      channelRef: trustedContext.channelRef,
      sellingLegalEntityRef: trustedContext.sellingLegalEntityRef,
    };
    const proof = (resourceId: string) => ({
      evidenceRef: ref('commerce.assortment', 'commerce.assortment.evidence', resourceId),
      ownerModuleId: 'commerce.assortment',
    });
    const factCurrentness = candidates.flatMap((candidateItem, index) => [
      {
        factRef: candidateItem.bindingRef,
        proof: proof(`binding-proof-${index}`),
        state: stale ? ('STALE' as const) : ('CURRENT' as const),
      },
      {
        factRef: candidateItem.ruleRevision.sourceRef,
        proof: proof(`revision-proof-${index}`),
        state: stale ? ('STALE' as const) : ('CURRENT' as const),
      },
    ]);
    const completenessEvidence = Schema.decodeUnknownSync(AssortmentSetCompletenessEvidenceSchema)({
      predicate: 'all current Candidate-producing bindings and immutable revisions for this exact decision',
      proof: proof('candidate-set-proof'),
      scope: 'commerce.assortment.ordinary-candidates',
      state: stale ? 'STALE' : 'COMPLETE',
    });
    const ordinaryInput = Schema.decodeUnknownSync(AssortmentOrdinaryResolutionInputSchema)({
      candidates,
      completeness: {
        evidence: completenessEvidence,
        scope: {
          commercialScope,
          decisionPurpose: 'PURCHASE',
          kind: 'ORDINARY_CANDIDATES',
          operationTime,
          subject,
          target: { kind: 'CATALOG_SELECTION', selection: requestedPayload.constituent.catalogSelection },
          tenantId,
        },
      },
      decisionPurpose: 'PURCHASE',
      factCurrentness,
      subject,
      target: { kind: 'CATALOG_SELECTION', selection: requestedPayload.constituent.catalogSelection },
      tenantId,
      trustedContext,
    });
    const attemptEvidence = Schema.decodeUnknownSync(AssortmentSuccessfulAttemptDecisionEvidenceSchema)({
      decision: {
        evidence: {
          candidates,
          factCurrentness,
          operationTime,
          setCompleteness: [completenessEvidence],
          subject,
          target: { kind: 'CATALOG_SELECTION', selection: requestedPayload.constituent.catalogSelection },
          trustedContext,
        },
        outcome: 'ELIGIBLE',
      },
      request: {
        constituent: requestedPayload.constituent,
        decisionPurpose: 'PURCHASE',
        subject,
        trustedContext,
      },
    });
    return Effect.succeed({
      attemptEvidence,
      attemptRef: requestedPayload.attemptRef,
      candidate: requestedPayload.candidate,
      constituent: requestedPayload.constituent,
      decisionEvidenceRef: requestedPayload.decisionEvidenceRef,
      ordinaryInput,
      prospectivePurchaseMeaningRef: requestedPayload.prospectivePurchaseMeaningRef,
    });
  },
});

const makeInMemoryRepository = () => {
  const persisted: AssortmentCommitmentConfirmationResult[] = [];
  const repository: AssortmentCommitmentConfirmationRepository = {
    persist: (_payload, result) =>
      Effect.sync(() => {
        persisted.push(result);
        return result;
      }),
  };
  return { persisted, repository };
};

it('binds a proof to the exact Attempt, Bundle meaning, constituent and Candidate', () => {
  expect(assortmentCommitmentConfirmationMatchesExactScope(confirmation, payload, issuedAt)).toBe(true);
  expect(
    assortmentCommitmentConfirmationMatchesExactScope(
      confirmation,
      { ...payload, attemptRef: ref('example.consumer', 'example.consumer.attempt', 'attempt-2') },
      issuedAt,
    ),
  ).toBe(false);
  expect(
    assortmentCommitmentConfirmationMatchesExactScope(
      confirmation,
      {
        ...payload,
        prospectivePurchaseMeaningRef: ref(
          'example.consumer',
          'example.consumer.prospective-purchase-meaning',
          'meaning-2',
        ),
      },
      issuedAt,
    ),
  ).toBe(false);
  expect(
    assortmentCommitmentConfirmationMatchesExactScope(
      confirmation,
      {
        ...payload,
        candidate: Schema.decodeUnknownSync(AssortmentCandidateSchema)({
          ...candidate,
          selector: { kind: 'VARIANT', variantRef: ref('catalog.owner', 'catalog.variant', 'variant-2') },
        }),
      },
      issuedAt,
    ),
  ).toBe(false);
  expect(
    assortmentCommitmentConfirmationMatchesExactScope(
      confirmation,
      {
        ...payload,
        constituent: Schema.decodeUnknownSync(AssortmentPurchaseConstituentSchema)({
          ...constituent,
          catalogSelection: {
            ...constituent.catalogSelection,
            variantRef: ref('catalog.owner', 'catalog.variant', 'variant-2'),
          },
        }),
      },
      issuedAt,
    ),
  ).toBe(false);
});

it.effect('uses the immutable half-open validity interval', () =>
  Effect.gen(function* halfOpenValidity() {
    expect(isAssortmentCommitmentConfirmationValidAt(confirmation, issuedAt)).toBe(true);
    expect(isAssortmentCommitmentConfirmationValidAt(confirmation, expiresAt)).toBe(false);
    const expired = yield* Effect.exit(validateAssortmentCommitmentConfirmation(confirmation, payload, expiresAt));
    expect(Exit.isFailure(expired)).toBe(true);
  }),
);

it.effect('rejects validation before issuance as invalid and permits overlapping proofs', () =>
  Effect.gen(function* beforeIssuance() {
    const beforeIssued = yield* Effect.exit(
      validateAssortmentCommitmentConfirmation(
        confirmation,
        payload,
        Schema.decodeUnknownSync(Schema.DateTimeUtcFromString)('2026-09-24T09:59:59.999Z'),
      ),
    );
    expect(Exit.isFailure(beforeIssued)).toBe(true);

    const overlapping = Schema.decodeUnknownSync(AssortmentCommitmentConfirmationResultSchema)({
      ...payload,
      confirmationRef: ref('commerce.assortment', 'commerce.assortment.commitment-confirmation', 'confirmation-2'),
      expiresAt: '2026-09-24T10:00:31.000Z',
      issuedAt: '2026-09-24T10:00:01.000Z',
    });
    expect(
      assortmentCommitmentConfirmationMatchesExactScope(
        overlapping,
        payload,
        Schema.decodeUnknownSync(Schema.DateTimeUtcFromString)('2026-09-24T10:00:01.000Z'),
      ),
    ).toBe(true);
  }),
);

it.effect('issues a selected maximal proof, renews it with overlap, and does not revalidate old evidence', () =>
  Effect.gen(function* issueAndRenew() {
    const firstRepository = makeInMemoryRepository();
    const service = makeAssortmentCommitmentConfirmationService(
      confirmationScope,
      makeAuthoritativeEvaluation(),
      firstRepository.repository,
    );
    const metadata = { actionInvocationId: 'invocation-1', actorPrincipalId: 'principal-1' };
    const first = yield* service.issue(payload, metadata);
    expect(firstRepository.persisted).toHaveLength(1);
    expect(first.candidate).toEqual(payload.candidate);

    const secondRepository = makeInMemoryRepository();
    const renewed = yield* makeAssortmentCommitmentConfirmationService(
      confirmationScope,
      makeAuthoritativeEvaluation(),
      secondRepository.repository,
    ).issue(payload, { actionInvocationId: 'invocation-2', actorPrincipalId: 'principal-1' });
    expect(renewed.confirmationRef.resourceId).not.toBe(first.confirmationRef.resourceId);
    expect(DateTime.toEpochMillis(renewed.issuedAt)).toBeGreaterThanOrEqual(DateTime.toEpochMillis(first.issuedAt));
    expect(DateTime.toEpochMillis(renewed.issuedAt)).toBeLessThan(DateTime.toEpochMillis(first.expiresAt));

    const stillValid = yield* validateAssortmentCommitmentConfirmation(first, payload, first.issuedAt);
    expect(stillValid.confirmationRef.resourceId).toBe(first.confirmationRef.resourceId);
    const renewedAtFirst = yield* validateAssortmentCommitmentConfirmation(first, payload, renewed.issuedAt);
    const renewedAtRenewal = yield* validateAssortmentCommitmentConfirmation(renewed, payload, renewed.issuedAt);
    expect(renewedAtFirst.confirmationRef.resourceId).toBe(first.confirmationRef.resourceId);
    expect(renewedAtRenewal.confirmationRef.resourceId).toBe(renewed.confirmationRef.resourceId);
  }),
);

it.effect('rejects a valid ALLOW candidate that is present but not maximal', () =>
  Effect.gen(function* rejectNonMaximal() {
    const broadCandidate = Schema.decodeUnknownSync(AssortmentCandidateSchema)({
      ...candidate,
      bindingRef: ref('commerce.assortment', 'commerce.assortment.applicability-binding', 'binding-broad'),
      ruleRevision: {
        ...candidate.ruleRevision,
        revision: 'r-broad',
        sourceRef: ref('commerce.assortment', 'commerce.assortment.rule-revision', 'revision-broad'),
      },
      selector: { kind: 'ALL' },
    });
    const broadPayload = Schema.decodeUnknownSync(AssortmentCommitmentConfirmationPayloadSchema)({
      ...payload,
      candidate: broadCandidate,
    });
    const failed = yield* Effect.exit(
      makeAssortmentCommitmentConfirmationService(
        confirmationScope,
        makeAuthoritativeEvaluation(false, [broadCandidate, candidate]),
        makeInMemoryRepository().repository,
      ).issue(broadPayload, { actionInvocationId: 'invocation-non-maximal', actorPrincipalId: 'principal-1' }),
    );
    expect(Exit.isFailure(failed)).toBe(true);
  }),
);

it.effect('rejects stale positive evidence and fails closed without an evaluator', () =>
  Effect.gen(function* rejectStaleAndUnavailable() {
    const staleRepository = makeInMemoryRepository();
    const staleExit = yield* Effect.exit(
      makeAssortmentCommitmentConfirmationService(
        confirmationScope,
        makeAuthoritativeEvaluation(true),
        staleRepository.repository,
      ).issue(payload, { actionInvocationId: 'invocation-stale', actorPrincipalId: 'principal-1' }),
    );
    expect(Exit.isFailure(staleExit)).toBe(true);
    expect(staleRepository.persisted).toHaveLength(0);

    const unavailableExit = yield* Effect.exit(
      makeAssortmentCommitmentConfirmationService(confirmationScope).issue(payload, {
        actionInvocationId: 'invocation-unavailable',
        actorPrincipalId: 'principal-1',
      }),
    );
    expect(Exit.isFailure(unavailableExit)).toBe(true);
  }),
);

it.effect('issues a required-component proof only for its own exact selection and role', () =>
  Effect.gen(function* confirmsExactComponent() {
    const componentPayload = {
      ...payload,
      constituent: { ...payload.constituent, role: 'REQUIRED_COMPONENT' as const },
    };
    const { persisted, repository } = makeInMemoryRepository();
    const service = makeAssortmentCommitmentConfirmationService(
      confirmationScope,
      makeAuthoritativeEvaluation(),
      repository,
    );
    const result = yield* service.issue(componentPayload, {
      actionInvocationId: 'component-issue-1',
      actorPrincipalId: confirmationScope.principalId,
    });
    expect(result.constituent.role).toBe('REQUIRED_COMPONENT');
    expect(persisted).toHaveLength(1);
    expect(
      assortmentCommitmentConfirmationMatchesExactScope(
        result,
        { ...componentPayload, constituent: payload.constituent },
        result.issuedAt,
      ),
    ).toBe(false);
    const wrongRoleEvaluation: AssortmentCommitmentConfirmationEvaluationPort = {
      evaluate: (requested, scope, now) =>
        makeAuthoritativeEvaluation().evaluate(
          { ...requested, constituent: { ...requested.constituent, role: 'TOP_LEVEL' } },
          scope,
          now,
        ),
    };
    const refused = yield* Effect.exit(
      makeAssortmentCommitmentConfirmationService(confirmationScope, wrongRoleEvaluation, repository).issue(
        componentPayload,
        { actionInvocationId: 'component-issue-2', actorPrincipalId: confirmationScope.principalId },
      ),
    );
    expect(Exit.isFailure(refused)).toBe(true);
    expect(persisted).toHaveLength(1);
  }),
);
