import { CurrentPricingDecisionRequestSchema } from '@app/pricing-contracts/current-pricing-decision';
import { PricingPurchaseContextVerificationEvidenceSchema } from '@app/commerce-customer-context/api/pricing-purchase-context-verification';
import { TrustedPrincipalContextSchema } from '@app/core-runtime';
import type { PricingEvaluationAttempt } from '@app/pricing-contracts/domain/material-change';
import {
  PricingEvaluationAttemptSchema,
  PricingMaterialStateSnapshotSchema,
} from '@app/pricing-contracts/domain/material-change';
import { ExactPriceResolutionSchema } from '@app/pricing-contracts/domain/exact-price-resolution';
import { PRICING_ALLOCATION_CONTRACT_VERSION } from '@app/pricing-contracts/domain/discount-fee-allocation';
import { PRICING_ALLOCATION_PROFILE } from '@app/pricing-contracts/domain/exact-decimal';
import type { PricingPromotionCompositionSelection } from '@app/pricing-contracts/domain/line-composition';
import type { PricingDecision, PricingDecisionOutcome, PricingLine } from '@app/pricing-contracts/pricing-decision';
import type { PricingUnitPriceCalculationAttempt } from '@app/pricing-contracts/domain/unit-price-calculation';
import { DateTime, Effect, Schema } from 'effect';
import { describe, expect, it } from 'effect-rstest';

import type {
  CurrentPricingDecisionExactPriceLineInput,
  CurrentPricingDecisionWholeCompositionPort,
} from '../../src/services/current-pricing-decision-whole-evaluation.service.ts';
import { makeCurrentPricingDecisionEvaluationFactory } from '../../src/services/current-pricing-decision-evaluation.service.ts';
import {
  CurrentPricingDecisionOwnerReadFailure,
  makeCurrentPricingDecisionWholeEvaluationService,
} from '../../src/services/current-pricing-decision-whole-evaluation.service.ts';
import { PricingPromotionUnavailable } from '../../src/services/pricing-promotion-unavailable.ts';
import type { CurrentPricingDecisionSubjectAuthorityEvidence } from '../../src/services/current-pricing-decision-subject-authority.service.ts';
import { makeIssue787Snapshot } from './support/issue-787-material-change.fixture.ts';
import { makeIssue779Scenario } from './support/issue-779-line-value.fixture.ts';
import {
  unitPriceCalculationAttempt,
  unitPriceFixtureEffectiveAt,
  unitPriceFixtureTenantId,
} from './support/unit-price-calculation.fixture.ts';

const unexpected = () => Effect.die('The pipeline must stop at the unavailable Tier owner read');
const unavailableExternalOwnerEvidence = { loadFresh: unexpected } as const;

const unavailableComposition: CurrentPricingDecisionWholeCompositionPort = {
  buildAllocationInput: unexpected,
  buildDiscountCompositionRequest: unexpected,
  buildLineCompositionRequest: unexpected,
  buildMaterialEvidenceRequest: unexpected,
  buildNoApplicablePrice: unexpected,
  buildPublicationInput: unexpected,
  resolvePromotionRequirement: unexpected,
};

const fixtureCommercialScope = {
  channelId: 'B2C' as const,
  marketId: 'cz-launch',
  sellingLegalEntityId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
};

const lineBindingGuestSubject = {
  guestEvidenceRef: 'guest-evidence:790-line-binding',
  guestSessionRef: 'guest-session:790-line-binding',
  kind: 'GUEST' as const,
};

const decisionFor = (lines: readonly [PricingLine, ...PricingLine[]]): PricingDecision => ({
  commercialScope: fixtureCommercialScope,
  currencyCode: 'CZK',
  lines,
  monetaryBoundary: 'PRE_TAX',
  operationTime: unitPriceFixtureEffectiveAt,
  purchasingContext: {
    accessDecision: { decisionRef: 'access-decision:790-line-binding', decisionRevision: '1' },
    actor: lineBindingGuestSubject,
    commercialSettingsDecision: {
      decisionRef: 'commercial-settings-decision:790-line-binding',
      decisionRevision: '1',
    },
    contextRef: 'purchase-790-line-binding',
    contextRevision: 'purchase-790-r1',
    currencyResolution: {
      currencyCode: 'CZK',
      resolutionRef: 'currency-resolution:790-line-binding',
      resolutionRevision: '1',
    },
    subject: lineBindingGuestSubject,
  },
  tenantId: unitPriceFixtureTenantId,
});

const attemptFor = (decision: PricingDecision): PricingEvaluationAttempt => {
  const snapshot = Schema.decodeSync(PricingMaterialStateSnapshotSchema, { onExcessProperty: 'error' })({
    attemptId: 'attempt-790-line-binding',
    calculationVersions: {
      allocationContractVersions: [],
      arithmeticProfileVersions: ['pricing-czk-arithmetic:v1'],
      publicationProfileVersions: ['pricing-czk-publication:v1'],
    },
    candidateRef: 'candidate-790-line-binding',
    capturedAt: unitPriceFixtureEffectiveAt,
    decision,
    materialBindings: [
      {
        bindingRef: 'binding:790-line-binding',
        kind: 'WHOLE_PURCHASE_BASIS_OR_ALLOCATION',
        meaningRef: 'meaning:790-line-binding',
        sourceEvidence: {
          _tag: 'UNVERIFIABLE',
          observedAt: unitPriceFixtureEffectiveAt,
          reason: 'OWNER_REFERENCE_UNVERIFIABLE',
          request: {
            currencyCode: decision.currencyCode,
            effectiveAt: decision.operationTime,
            family: 'COMMERCIAL_CONTEXT',
            ownerScope: {
              ownerModuleId: 'commerce.pricing',
              ownerRootRef: 'pricing-current-decision:whole-candidate',
              predicateRef: 'pricing-current-decision:whole-candidate',
              tenantId: decision.tenantId,
            },
            requestedAt: unitPriceFixtureEffectiveAt,
          },
          retryable: true,
        },
      },
    ],
    requestedAt: unitPriceFixtureEffectiveAt,
    snapshotId: 'snapshot-790-line-binding',
  });
  return Schema.decodeSync(PricingEvaluationAttemptSchema, { onExcessProperty: 'error' })({
    attemptId: snapshot.attemptId,
    attemptOrdinal: 1,
    candidateRef: snapshot.candidateRef,
    completedAt: unitPriceFixtureEffectiveAt,
    maxAttempts: 2,
    runId: 'run-790-line-binding',
    snapshot,
    startedAt: unitPriceFixtureEffectiveAt,
  });
};

const requestFor = (decision: PricingDecision) =>
  Schema.decodeSync(CurrentPricingDecisionRequestSchema, { onExcessProperty: 'error' })({
    decision,
    subject: decision.purchasingContext.subject,
  });

const trustedScopeFor = (request: ReturnType<typeof requestFor>) => {
  const principal = Schema.decodeSync(TrustedPrincipalContextSchema)({
    authBindingId: '79000000-0000-4000-8000-000000000121',
    authContextRef: 'session:issue-790-whole-evaluation',
    authMethod: 'session',
    principalId: '79000000-0000-4000-8000-000000000120',
    tenantId: request.decision.tenantId,
  });
  const common = {
    actingPrincipalId: principal.principalId,
    currentness: {
      evaluatedAt: request.decision.operationTime,
      observedAt: request.decision.operationTime,
      validFrom: request.decision.operationTime,
      validTo: null,
    },
    ownerRef: request.decision.purchasingContext.contextRef,
    ownerRevisionRef: request.decision.purchasingContext.contextRevision,
    verificationRef: 'purchase-context-verification:issue-790-whole-evaluation',
    verifiedScope: {
      channelId: request.decision.commercialScope.channelId,
      legalEntityId: request.decision.commercialScope.sellingLegalEntityId,
      marketId: request.decision.commercialScope.marketId,
      tenantId: request.decision.tenantId,
    },
  };
  const purchaseContextEvidence: CurrentPricingDecisionSubjectAuthorityEvidence = Schema.decodeUnknownSync(
    PricingPurchaseContextVerificationEvidenceSchema,
  )(
    request.subject.kind === 'GUEST'
      ? {
          ...common,
          subjectAuthority: {
            guestEvidenceAuthorityRef: 'guest-evidence-authority:issue-790-whole-evaluation',
            guestSessionAuthorityRef: 'guest-session-authority:issue-790-whole-evaluation',
            kind: 'GUEST',
            subject: request.subject,
            subjectAuthorityRevisionRef: 'guest-authority-revision:issue-790-whole-evaluation',
          },
        }
      : {
          ...common,
          subjectAuthority: {
            actorPrincipalId: principal.principalId,
            kind: 'PROFILE',
            partyAuthorityRef: 'party-authority:issue-790-whole-evaluation',
            partyAuthorityRevisionRef: 'party-authority-revision:issue-790-whole-evaluation',
            subject: request.subject,
            subjectAuthorityRef: 'profile-authority:issue-790-whole-evaluation',
            subjectAuthorityRevisionRef: 'profile-authority-revision:issue-790-whole-evaluation',
          },
        },
  );
  return {
    purchaseContextEvidence,
    sellingLegalEntityId: request.decision.commercialScope.sellingLegalEntityId,
    tenantId: request.decision.tenantId,
  };
};

const exactPriceLineFor = (
  value: PricingUnitPriceCalculationAttempt,
  decision: PricingDecision,
): CurrentPricingDecisionExactPriceLineInput => {
  const exactPriceLine = {
    exactPrice: value.exactPrice,
    exactPriceInput: {
      currencySupport: value.exactPrice.currencySupport,
      resolutionInput: value.exactPrice.path.resolutionInput,
    },
    exactPriceTrustedContext: {
      legalEntityId: decision.commercialScope.sellingLegalEntityId,
      tenantId: decision.tenantId,
      trustedOperationAt: DateTime.makeUnsafe(decision.operationTime),
    },
    line: value.line,
    priceCandidateSetAuthorities: [
      {
        authority: {
          generation: 1,
          kind: 'PERSISTENT' as const,
          observedAt: decision.operationTime,
          ownerRevision: 'price-candidate-set-revision:790',
          ownerRootRef: 'price-candidate-set-root:790',
          predicateRef: 'price-candidate-set-predicate:790',
          verificationRef: 'price-candidate-set-verification:790',
        },
        factProofs:
          'usedPrice' in value.exactPrice.path
            ? [
                {
                  factRef: value.exactPrice.path.usedPrice.priceRef.resourceId,
                  factRevisionRef: value.exactPrice.path.usedPrice.priceRevision.revisionId,
                  verificationRef: 'price-candidate-set-verification:790',
                },
              ]
            : [],
      },
    ] as const,
    quantityBasis: value.quantityBasis,
  };
  return value.lineQuantity === undefined ? exactPriceLine : { ...exactPriceLine, lineQuantity: value.lineQuantity };
};

describe('Current Pricing Decision whole evaluation source', () => {
  it.effect('closes an unavailable whole-attempt authority as a typed indeterminate result', () =>
    Effect.gen(function* unavailableWholeAttempt() {
      const snapshot = makeIssue787Snapshot();
      const request = yield* Schema.decodeEffect(CurrentPricingDecisionRequestSchema, { onExcessProperty: 'error' })({
        decision: snapshot.decision,
        subject: snapshot.decision.purchasingContext.subject,
      });
      const requiredOwnerRefs = ['pricing-current-decision:whole-attempt-source'] as const;
      const source = makeCurrentPricingDecisionWholeEvaluationService({
        attemptSource: {
          loadFresh: () =>
            Effect.fail(
              new CurrentPricingDecisionOwnerReadFailure({
                kind: 'UNAVAILABLE',
                ownerRefs: requiredOwnerRefs,
                reason: 'No atomic owner snapshot authority is installed',
              }),
            ),
        },
        composition: unavailableComposition,
        discountReader: { loadCurrent: unexpected },
        externalOwnerEvidence: unavailableExternalOwnerEvidence,
        feeReader: { loadCurrent: unexpected },
        floorReader: { loadCurrent: unexpected },
        promotionEvaluation: { evaluate: unexpected },
        tierReader: { loadCurrent: unexpected },
      });

      const result = yield* source.loadFresh(request, trustedScopeFor(request), 1);

      expect(result.attempt.kind).toBe('INDETERMINATE_OR_UNVERIFIABLE');
      expect(result.attempt.attempt.snapshot.materialBindings[0]?.sourceEvidence).toMatchObject({
        reason: 'OWNER_UNAVAILABLE',
        retryable: true,
      });
      expect(result.outcome).toMatchObject({
        inabilityEvidence: { attempts: 1, requiredOwnerRefs },
        outcome: 'PRICING_INDETERMINATE',
        reasonCode: 'OWNER_STATE_UNAVAILABLE',
        retryable: true,
      });
    }),
  );

  it.effect('builds an environment-free evaluator around the supplied scoped source', () =>
    Effect.gen(function* scopedFactory() {
      const snapshot = makeIssue787Snapshot();
      const attempt = yield* Schema.decodeEffect(PricingEvaluationAttemptSchema, { onExcessProperty: 'error' })({
        attemptId: snapshot.attemptId,
        attemptOrdinal: 1,
        candidateRef: snapshot.candidateRef,
        completedAt: '2026-09-28T10:00:00.500Z',
        maxAttempts: 2,
        runId: 'run-790-evaluation-factory',
        snapshot,
        startedAt: '2026-09-28T10:00:00.000Z',
      });
      const request = yield* Schema.decodeEffect(CurrentPricingDecisionRequestSchema, { onExcessProperty: 'error' })({
        decision: snapshot.decision,
        subject: snapshot.decision.purchasingContext.subject,
      });
      const requiredOwnerRefs = ['pricing-current-decision:whole-attempt-source'] as const;
      const expected = {
        candidate: {
          candidateRef: attempt.candidateRef,
          occurrenceIds: request.decision.lines.map(({ occurrenceId }) => occurrenceId),
        },
        outcome: 'PRICING_CONFIGURATION_ERROR' as const,
        reasonCode: 'INVALID_CANONICAL_CONFIGURATION' as const,
        retryable: false,
      } satisfies PricingDecisionOutcome;
      const evaluator = makeCurrentPricingDecisionEvaluationFactory(unexpected).make({
        loadFresh: () =>
          Effect.succeed({
            attempt: { attempt, kind: 'KNOWN_INVALID_OR_CONFLICT', reason: 'Invalid canonical configuration' },
            outcome: expected,
            requiredOwnerRefs,
          }),
      });

      const result = yield* evaluator.evaluate(request, trustedScopeFor(request));

      expect(result).toEqual({ kind: 'NON_RESOLVED', outcome: expected });
    }),
  );

  it.effect('keeps an unavailable Current Tier set typed and never treats it as an empty set', () =>
    Effect.gen(function* unavailableTierSet() {
      const unitPriceAttempt = yield* unitPriceCalculationAttempt();
      const decision = decisionFor([unitPriceAttempt.line]);
      const request = requestFor(decision);
      const attempt = attemptFor(decision);
      const requiredOwnerRefs = ['pricing:quantity-tier-set:790'] as const;
      const exactPriceLine = exactPriceLineFor(unitPriceAttempt, decision);
      const dependencies: Parameters<typeof makeCurrentPricingDecisionWholeEvaluationService>[0] = {
        attemptSource: {
          loadFresh: () =>
            Effect.succeed({
              attempt,
              exactPriceLines: [exactPriceLine],
              requiredOwnerRefs,
            }),
        },
        composition: unavailableComposition,
        discountReader: { loadCurrent: unexpected },
        externalOwnerEvidence: unavailableExternalOwnerEvidence,
        feeReader: { loadCurrent: unexpected },
        floorReader: { loadCurrent: unexpected },
        promotionEvaluation: { evaluate: unexpected },
        tierReader: {
          loadCurrent: () =>
            Effect.fail(
              new CurrentPricingDecisionOwnerReadFailure({
                kind: 'UNAVAILABLE',
                ownerRefs: requiredOwnerRefs,
                reason: 'Current Tier-set owner read unavailable',
              }),
            ),
        },
      };
      const service = makeCurrentPricingDecisionWholeEvaluationService(dependencies);

      const result = yield* service.loadFresh(request, trustedScopeFor(request), 1);

      expect(result.attempt.kind).toBe('INDETERMINATE_OR_UNVERIFIABLE');
      expect(result.outcome).toMatchObject({
        inabilityEvidence: { attempts: 1, requiredOwnerRefs },
        outcome: 'PRICING_INDETERMINATE',
        reasonCode: 'OWNER_STATE_UNAVAILABLE',
        retryable: true,
      });
    }),
  );

  it.effect('allows exact Price absence to close without fabricating a Price-backed Quantity basis', () =>
    Effect.gen(function* absentPriceWithoutBasis() {
      const unitPriceAttempt = yield* unitPriceCalculationAttempt();
      const decision = decisionFor([unitPriceAttempt.line]);
      const request = requestFor(decision);
      const attempt = attemptFor(decision);
      const boundLine = exactPriceLineFor(unitPriceAttempt, decision);
      const { path } = unitPriceAttempt.exactPrice;
      if (!('usedPrice' in path)) {
        throw new Error('Issue #790 absence fixture requires one resolved exact no-group Price path');
      }
      const absent = yield* Schema.decodeEffect(ExactPriceResolutionSchema, { onExcessProperty: 'error' })({
        _tag: 'NO_APPLICABLE_PRICE',
        currencySupport: unitPriceAttempt.exactPrice.currencySupport,
        path: {
          _tag: 'NO_APPLICABLE_PRICE',
          noGroupAbsence: { _tag: 'ABSENT', evidence: path.usedPrice.evidence, request: path.usedPrice.request },
          resolutionInput: path.resolutionInput,
        },
      });
      const deferredLine: CurrentPricingDecisionExactPriceLineInput = {
        exactPrice: absent,
        exactPriceInput: boundLine.exactPriceInput,
        exactPriceTrustedContext: boundLine.exactPriceTrustedContext,
        line: boundLine.line,
        priceCandidateSetAuthorities: boundLine.priceCandidateSetAuthorities.map((receipt) => ({
          ...receipt,
          authority: { ...receipt.authority, observedAt: '2026-09-28T12:00:00.750Z' },
        })),
      };
      const requiredOwnerRefs = ['pricing:exact-price-set:790'] as const;
      let noPriceCompositionCalled = false;
      let finalizedNoPriceAttempt: PricingEvaluationAttempt | undefined;
      const service = makeCurrentPricingDecisionWholeEvaluationService({
        attemptSource: {
          loadFresh: () => Effect.succeed({ attempt, exactPriceLines: [deferredLine], requiredOwnerRefs }),
        },
        composition: {
          ...unavailableComposition,
          buildNoApplicablePrice: ({ attempt: completedAttempt }) => {
            noPriceCompositionCalled = true;
            finalizedNoPriceAttempt = completedAttempt;
            return Effect.fail(
              new CurrentPricingDecisionOwnerReadFailure({
                kind: 'UNAVAILABLE',
                ownerRefs: requiredOwnerRefs,
                reason: 'No-price proof composition owner unavailable',
              }),
            );
          },
        },
        discountReader: { loadCurrent: unexpected },
        externalOwnerEvidence: unavailableExternalOwnerEvidence,
        feeReader: { loadCurrent: unexpected },
        floorReader: { loadCurrent: unexpected },
        promotionEvaluation: { evaluate: unexpected },
        tierReader: { loadCurrent: unexpected },
      });

      const result = yield* service.loadFresh(request, trustedScopeFor(request), 1);

      expect(noPriceCompositionCalled).toBe(true);
      expect(finalizedNoPriceAttempt?.completedAt).toBe('2026-09-28T12:00:00.750Z');
      expect(finalizedNoPriceAttempt?.snapshot.capturedAt).toBe('2026-09-28T12:00:00.750Z');
      expect(result.outcome).toMatchObject({
        outcome: 'PRICING_INDETERMINATE',
        reasonCode: 'OWNER_STATE_UNAVAILABLE',
      });
    }),
  );

  it.effect('requires the exact scheduled Price-backed Quantity basis only after Price resolves', () =>
    Effect.gen(function* resolvedPriceRequiresBasis() {
      const unitPriceAttempt = yield* unitPriceCalculationAttempt();
      const decision = decisionFor([unitPriceAttempt.line]);
      const request = requestFor(decision);
      const attempt = attemptFor(decision);
      const boundLine = exactPriceLineFor(unitPriceAttempt, decision);
      const deferredLine: CurrentPricingDecisionExactPriceLineInput = {
        exactPrice: boundLine.exactPrice,
        exactPriceInput: boundLine.exactPriceInput,
        exactPriceTrustedContext: boundLine.exactPriceTrustedContext,
        line: boundLine.line,
        priceCandidateSetAuthorities: boundLine.priceCandidateSetAuthorities,
      };
      const requiredOwnerRefs = ['pricing:exact-price-set:790'] as const;
      const service = makeCurrentPricingDecisionWholeEvaluationService({
        attemptSource: {
          loadFresh: () => Effect.succeed({ attempt, exactPriceLines: [deferredLine], requiredOwnerRefs }),
        },
        composition: unavailableComposition,
        discountReader: { loadCurrent: unexpected },
        externalOwnerEvidence: unavailableExternalOwnerEvidence,
        feeReader: { loadCurrent: unexpected },
        floorReader: { loadCurrent: unexpected },
        promotionEvaluation: { evaluate: unexpected },
        tierReader: { loadCurrent: unexpected },
      });

      const result = yield* service.loadFresh(request, trustedScopeFor(request), 1);

      expect(result.outcome).toMatchObject({
        outcome: 'PRICING_INDETERMINATE',
        reasonCode: 'CURRENTNESS_UNVERIFIABLE',
      });
    }),
  );

  it.effect('continues ordinary Pricing without calling Promotion when no contribution was selected', () =>
    Effect.gen(function* ordinaryWithoutPromotion() {
      const scenario = yield* makeIssue779Scenario();
      const { compositionRequest, unitPrice } = scenario;
      const { decision } = compositionRequest;
      const request = yield* Schema.decodeEffect(CurrentPricingDecisionRequestSchema, { onExcessProperty: 'error' })({
        decision,
        subject: decision.purchasingContext.subject,
      });
      const attempt = attemptFor(decision);
      const exactPriceLine = exactPriceLineFor(unitPrice.input, decision);
      const [feeResult] = compositionRequest.feeResults;
      if (feeResult?.outcome !== 'COMMERCIAL_FEES_APPLIED') {
        throw new Error('Issue #790 ordinary path fixture requires an applied Fee result');
      }
      const { tierSelection } = unitPrice.input;

      let promotionCalls = 0;
      let capturedSelection: PricingPromotionCompositionSelection | null = null;
      let lastStage = 'attempt-source';
      const stopAtFloor = new CurrentPricingDecisionOwnerReadFailure({
        kind: 'UNAVAILABLE',
        ownerRefs: ['pricing:zero-floor-set:790-ordinary'],
        reason: 'Stop after proving the no-Promotion line-composition branch',
      });
      const dependencies: Parameters<typeof makeCurrentPricingDecisionWholeEvaluationService>[0] = {
        attemptSource: {
          loadFresh: () =>
            Effect.succeed({
              attempt,
              exactPriceLines: [exactPriceLine],
              requiredOwnerRefs: ['pricing:ordinary-current:790'],
            }),
        },
        composition: {
          ...unavailableComposition,
          buildAllocationInput: ({ discountComposition, feeResults }) =>
            Effect.sync(() => {
              lastStage = 'allocation-input';
              return {
                discountComposition,
                feeResults: feeResults.filter((result) => result.outcome === 'COMMERCIAL_FEES_APPLIED'),
                precision: {
                  allocationScale: PRICING_ALLOCATION_PROFILE.maximumScale,
                  amountPrecision: PRICING_ALLOCATION_PROFILE.maximumPrecision,
                  contractVersion: PRICING_ALLOCATION_CONTRACT_VERSION,
                  remainderRule: PRICING_ALLOCATION_PROFILE.remainderRule,
                },
                recipientClassifications: decision.lines.map(({ occurrenceId }) => ({
                  occurrenceId,
                  recipientKind: 'MERCHANDISE' as const,
                })),
              };
            }),
          buildDiscountCompositionRequest: () =>
            Effect.sync(() => {
              lastStage = 'discount-composition';
              return compositionRequest.discountComposition.request;
            }),
          buildLineCompositionRequest: ({
            allocation,
            discountComposition,
            feeResults,
            promotionSelection,
            unitPrices,
          }) => {
            lastStage = 'line-composition';
            capturedSelection = promotionSelection;
            const wholePurchaseAllocation = allocation.allocationResults.find(
              (result) => result.outcome === 'ALLOCATION_APPLIED',
            );
            const lineComposition = {
              candidateRef: attempt.candidateRef,
              decision,
              discountComposition,
              feeResults: feeResults.filter((result) => result.outcome === 'COMMERCIAL_FEES_APPLIED'),
              promotionComposition: promotionSelection,
              unitPrices,
            };
            return Effect.succeed(
              wholePurchaseAllocation === undefined ? lineComposition : { ...lineComposition, wholePurchaseAllocation },
            );
          },
          resolvePromotionRequirement: () =>
            Effect.sync(() => {
              lastStage = 'promotion-requirement';
              return { kind: 'PROMOTION_NOT_SELECTED' as const };
            }),
        },
        discountReader: {
          loadCurrent: () => Effect.succeed({ applicabilityInputs: [], currentSets: [] }),
        },
        externalOwnerEvidence: unavailableExternalOwnerEvidence,
        feeReader: {
          loadCurrent: () =>
            Effect.succeed({
              authority: {
                generation: 1,
                observedAt: decision.operationTime,
                ownerRevision: 'fee-set-revision:790',
                ownerRootRef: 'fee-set-root:790',
                predicateRef: 'fee-set-predicate:790',
                verificationRef: 'fee-set-verification:790',
              },
              factProofs: [],
              input: feeResult.input,
            }),
        },
        floorReader: { loadCurrent: () => Effect.fail(stopAtFloor) },
        promotionEvaluation: {
          evaluate: () => {
            promotionCalls += 1;
            return Effect.die('Promotion must not be called for an ordinary Pricing request');
          },
        },
        tierReader: {
          loadCurrent: () =>
            Effect.succeed({
              authority: {
                generation: 1,
                observedAt: decision.operationTime,
                ownerRevision: 'tier-set-revision:790',
                ownerRootRef: 'tier-set-root:790',
                predicateRef: 'tier-set-predicate:790',
                verificationRef: 'tier-set-verification:790',
              },
              request: { input: tierSelection.evidence.input, outcome: 'TIER_SET_CURRENT' },
            }),
        },
      };
      const service = makeCurrentPricingDecisionWholeEvaluationService(dependencies);

      const result = yield* service.loadFresh(request, trustedScopeFor(request), 1);

      expect(capturedSelection, lastStage).toEqual({ kind: 'PROMOTION_NOT_SELECTED' });
      expect(promotionCalls).toBe(0);
      expect(result.outcome).toMatchObject({
        outcome: 'PRICING_INDETERMINATE',
        reasonCode: 'CURRENTNESS_UNVERIFIABLE',
      });

      capturedSelection = null;
      const selectedService = makeCurrentPricingDecisionWholeEvaluationService({
        ...dependencies,
        composition: {
          ...dependencies.composition,
          resolvePromotionRequirement: () =>
            Effect.succeed({ kind: 'PROMOTION_SELECTED', source: { loadFresh: unexpected } }),
        },
        promotionEvaluation: {
          evaluate: () => {
            promotionCalls += 1;
            return Effect.fail(
              new PricingPromotionUnavailable({ reason: 'Selected Promotion owner is unavailable', retryable: true }),
            );
          },
        },
      });
      const selectedResult = yield* selectedService.loadFresh(request, trustedScopeFor(request), 1);

      expect(promotionCalls).toBe(1);
      expect(capturedSelection).toBeNull();
      expect(selectedResult.outcome).toMatchObject({
        outcome: 'PRICING_INDETERMINATE',
        reasonCode: 'OWNER_STATE_UNAVAILABLE',
      });
    }),
  );

  it.effect('rejects same-count reordered lines and foreign trusted Tenant, SLE, or operation time before lookup', () =>
    Effect.gen(function* adversarialLineBindings() {
      const first = yield* unitPriceCalculationAttempt({ occurrenceId: 'line-790-a' });
      const second = yield* unitPriceCalculationAttempt({ occurrenceId: 'line-790-b' });
      const decision = decisionFor([first.line, second.line]);
      const request = requestFor(decision);
      const attempt = attemptFor(decision);
      const firstLine = exactPriceLineFor(first, decision);
      const secondLine = exactPriceLineFor(second, decision);
      const requiredOwnerRefs = ['pricing-current-decision:line-binding'] as const;
      const cases: readonly (readonly [
        string,
        readonly [CurrentPricingDecisionExactPriceLineInput, CurrentPricingDecisionExactPriceLineInput],
      ])[] = [
        ['same-count reordered lines', [secondLine, firstLine]],
        [
          'foreign trusted Tenant',
          [
            {
              ...firstLine,
              exactPriceTrustedContext: {
                ...firstLine.exactPriceTrustedContext,
                tenantId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
              },
            },
            secondLine,
          ],
        ],
        [
          'foreign trusted SLE',
          [
            {
              ...firstLine,
              exactPriceTrustedContext: {
                ...firstLine.exactPriceTrustedContext,
                legalEntityId: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
              },
            },
            secondLine,
          ],
        ],
        [
          'foreign trusted operation time',
          [
            {
              ...firstLine,
              exactPriceTrustedContext: {
                ...firstLine.exactPriceTrustedContext,
                trustedOperationAt: DateTime.makeUnsafe('2026-09-28T12:00:00.001Z'),
              },
            },
            secondLine,
          ],
        ],
      ];

      for (const [caseName, exactPriceLines] of cases) {
        const service = makeCurrentPricingDecisionWholeEvaluationService({
          attemptSource: { loadFresh: () => Effect.succeed({ attempt, exactPriceLines, requiredOwnerRefs }) },
          composition: unavailableComposition,
          discountReader: { loadCurrent: unexpected },
          externalOwnerEvidence: unavailableExternalOwnerEvidence,
          feeReader: { loadCurrent: unexpected },
          floorReader: { loadCurrent: unexpected },
          promotionEvaluation: { evaluate: unexpected },
          tierReader: { loadCurrent: unexpected },
        });

        const result = yield* service.loadFresh(request, trustedScopeFor(request), 1);

        expect(result.outcome, caseName).toMatchObject({
          outcome: 'PRICING_INDETERMINATE',
          reasonCode: 'CURRENTNESS_UNVERIFIABLE',
          retryable: true,
        });
      }
    }),
  );
});
