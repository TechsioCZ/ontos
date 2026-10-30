import { TestClock } from 'effect/testing';
import { makeApplicationCompositionSnapshotFixture } from '@app/core-runtime/testing/module-contract';
import {
  PricingPurposeEquivalenceRequestSchema,
  PricingPurposeEquivalenceResponseSchema,
} from '@app/catalog/api/pricing-purpose-equivalence';
import type { PricingPurposeEquivalenceRequest } from '@app/catalog/api/pricing-purpose-equivalence';
import type { QuantityBasisCompatibilityRequest } from '@app/catalog/api/quantity-basis-compatibility';
import { CatalogQuantityHandoffReadySchema } from '@app/catalog/domain/catalog-quantity-handoff';
import {
  PricingCurrentMarketEvidenceRequestSchema,
  PricingCurrentMarketEvidenceResponseSchema,
} from '@app/commerce-market-catalog/api/pricing-current-market-evidence';
import type { PricingCurrentMarketEvidenceRequest } from '@app/commerce-market-catalog/api/pricing-current-market-evidence';
import { PricingUnitPriceCalculationAttemptSchema } from '@app/pricing-contracts/domain/unit-price-calculation';
import { PricingCommercialTotalReadySchema } from '@app/pricing-contracts/domain/commercial-total';
import {
  PricingCommercialFeeCalculationInputSchema,
  pricingCommercialFeeCurrentSetPredicateRef,
} from '@app/pricing-contracts/domain/commercial-fee';
import { makeCurrentPricingDecisionExternalOwnerEvidenceLivePort } from '../../src/integrations/current-pricing-decision-external-owner-evidence-live.ts';
import { makeCurrentPricingDecisionWholeComposition } from '../../src/integrations/current-pricing-decision-whole-evaluation-adapters.ts';
import { makePricingExternalOwnerEvidenceValidationService } from '../../src/services/external-owner-evidence-validation.service.ts';
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
import { DateTime, Effect, Match, Redacted, Schema } from 'effect';
import { assert, describe, expect, it } from 'effect-rstest';

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
import { selectQuantityTier } from '../../src/services/quantity-tier-selection.service.ts';
import { sumQuantityTierNormalizedQuantities } from '@app/pricing-contracts/domain/quantity-tier-aggregation';
import type { CurrentPricingDecisionSubjectAuthorityEvidence } from '../../src/services/current-pricing-decision-subject-authority.service.ts';
import { makeIssue787Snapshot } from './support/issue-787-material-change.fixture.ts';
import { authorizationSetFor, makeIssue779Scenario } from './support/issue-779-line-value.fixture.ts';
import {
  unitPriceCalculationAttempt,
  unitPriceFixtureProductRef,
  unitPriceFixtureVariantRef,
  unitPriceFixturePriceRef,
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
      const evaluator = makeCurrentPricingDecisionEvaluationFactory(unexpected).make(
        {
          loadFresh: () =>
            Effect.succeed({
              attempt: { attempt, kind: 'KNOWN_INVALID_OR_CONFLICT', reason: 'Invalid canonical configuration' },
              outcome: expected,
              requiredOwnerRefs,
            }),
        },
        undefined,
        'revision:790',
      );

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

// Explicit owner-contract fixtures exercise the actual repaired reader and whole math.
// Native owner authenticity and public provider reach are separate integration evidence.
const catalogContract1225 = (
  questions: PricingPurposeEquivalenceRequest[],
  inputs: readonly PricingUnitPriceCalculationAttempt[],
) => ({
  execute: (payload: PricingPurposeEquivalenceRequest) =>
    Effect.gen(function* declaredCatalogEquivalence1225() {
      expect(Schema.is(PricingPurposeEquivalenceRequestSchema)(payload)).toBe(true);
      expect(payload.members).toHaveLength(1);
      const [member] = payload.members;
      assert(member !== undefined);
      const retained = inputs.find(({ line }) => line.occurrenceId === member.occurrenceId);
      assert(retained !== undefined);
      expect(member.handoff).toEqual(retained.line.catalog);
      expect(payload.anchorSelection).toEqual(retained.line.catalog.selection);
      questions.push(payload);
      const handoff = retained.line.catalog;
      const at = payload.effectiveAt;
      const observedAt = handoff.evidence.assessedAt;
      const validThrough = handoff.evidence.validUntil;
      assert(validThrough !== undefined);
      const predicateRef = `TEST:1225:singleton:${member.occurrenceId}`;
      const generation = handoff.ownerRevision;
      const target = {
        quantityBasis: handoff.quantityBasis,
        requestedQuantity: handoff.quantity.requested,
        selection: handoff.selection,
      };
      return yield* Schema.decodeUnknownEffect(PricingPurposeEquivalenceResponseSchema)({
        assessments: [
          { handoff, role: 'ANCHOR' },
          { handoff, occurrenceId: member.occurrenceId, role: 'MEMBER' },
        ],
        currentness: { effectiveAt: at, observedAt, status: 'CURRENT', validThrough },
        currentnessEvidence: {
          effectiveAt: at,
          generation,
          observedAt,
          predicateRef,
          revalidatedAt: observedAt,
          validThrough,
          verificationMode: 'OWNER_CURRENT_QUANTITY_REVALIDATED',
        },
        evidence: {
          anchorSelection: handoff.selection,
          assessmentId: `TEST:1225:assessment:${member.occurrenceId}`,
          effectiveAt: at,
          members: [{ occurrenceId: member.occurrenceId, selection: handoff.selection }],
          observedAt,
          ownerModuleId: 'commerce.catalog',
          ownerRevision: handoff.ownerRevision,
          purpose: 'PRICING',
          status: 'CONFIRMED',
          validThrough,
        },
        generation,
        outcome: 'CATALOG_EQUIVALENCE_CONFIRMED',
        verificationReceipt: {
          generation,
          issuedAt: observedAt,
          ownerModuleId: 'commerce.catalog',
          ownerRevision: handoff.ownerRevision,
          predicate: {
            anchor: target,
            effectiveAt: at,
            members: [{ ...target, occurrenceId: member.occurrenceId }],
            purpose: 'PRICING',
          },
          predicateRef,
          verificationRef: `TEST:1225:equivalence:${member.occurrenceId}`,
        },
      });
    }).pipe(Effect.orDie),
  executeCompatibility: (payload: QuantityBasisCompatibilityRequest) =>
    Effect.sync(() => {
      const matching = inputs.find(({ line }) =>
        Schema.toEquivalence(CatalogQuantityHandoffReadySchema)(line.catalog, payload.handoff),
      );
      assert(matching !== undefined);
      expect(payload.price.quantity).toBe(matching.line.pricingBasis.quantity);
      assert(matching.quantityBasis.outcome === 'NO_CONVERSION_REQUIRED');
      return matching.quantityBasis.evidence;
    }),
  issuer: {
    issue: () =>
      Effect.succeed({
        baseUrl: new URL('http://127.0.0.1:1225'),
        credential: Redacted.make('TEST:1225:owner-contract-only'),
      }),
  },
});

const marketContract1225 = (payload: PricingCurrentMarketEvidenceRequest) =>
  Effect.gen(function* declaredMarketResponse1225() {
    const encodedRequest = yield* Schema.encodeEffect(PricingCurrentMarketEvidenceRequestSchema)(payload);
    const { channel, marketRef, sellingLegalEntityRef } = payload.commercialScope;
    const observedAt = encodedRequest.effectiveAt;
    const response = yield* Schema.decodeUnknownEffect(PricingCurrentMarketEvidenceResponseSchema)({
      market: {
        channels: [channel],
        definitionRevisionRef: {
          ...marketRef,
          resourceId: 'TEST:1225:market-definition',
          resourceType: 'commerce.market-catalog.market-definition-revision',
        },
        effectivePeriod: { startsAt: encodedRequest.effectiveAt },
        jurisdictions: [{ code: 'CZ', kind: 'COUNTRY' }],
        lifecycle: 'ACTIVE',
        marketCode: 'CZ',
        marketRef,
        purpose: 'Explicit TEST non-Catalog prerequisite',
        revision: 1,
        sellingLegalEntityRef,
        supportedLocales: ['cs-CZ'],
      },
      outcome: 'PRICING_MARKET_SOURCE_PRESENT',
      receipt: {
        authority: {
          generation: 1,
          observedAt,
          ownerRootRef: 'TEST:1225:market-root',
          ownerSetRevisionRef: 'TEST:1225:market-set',
          predicateRef: 'TEST:1225:market-predicate',
          verificationRef: 'TEST:1225:market-proof',
        },
        currentFacts: [
          {
            effectivePeriod: { startsAt: encodedRequest.effectiveAt },
            factRef: marketRef.resourceId,
            factRevisionRef: 'TEST:1225:market-definition',
            verificationRef: 'TEST:1225:market-proof',
          },
        ],
        state: 'PRESENT',
      },
      request: encodedRequest,
    });
    return yield* Schema.encodeEffect(PricingCurrentMarketEvidenceResponseSchema)(response);
  }).pipe(Effect.orDie);

for (const variant of [
  'different Products',
  'same Product non-equivalent Variants',
  'singleton',
  'equal-valued distinct occurrences',
] as const) {
  it.effect(`retains ${variant} through successful actual Catalog reader and whole monetary consumer #1225`, () =>
    Effect.gen(function* successfulWholeCatalog1225() {
      yield* TestClock.setTime(DateTime.toEpochMillis(DateTime.makeUnsafe('2026-09-28T12:00:00.500Z')));
      const first = yield* unitPriceCalculationAttempt({
        groupPath: false,
        occurrenceId: 'TEST:1225:original-A',
        priceAmount: '100',
        quantity: '1',
      });
      const inputs = [first];
      if (variant !== 'singleton') {
        // Clone only this schema-checked owning unit fixture; no real owner proof is rewritten.
        const codec = Schema.fromJsonString(PricingUnitPriceCalculationAttemptSchema);
        let encoded = yield* Schema.encodeEffect(codec)(first);
        encoded = encoded.replaceAll('TEST:1225:original-A', 'TEST:1225:original-B');
        if (variant !== 'equal-valued distinct occurrences') {
          encoded = encoded
            .replaceAll(unitPriceFixtureVariantRef.resourceId, '33333333-3333-4333-8333-333333333334')
            .replaceAll(unitPriceFixturePriceRef.resourceId, '55555555-5555-4555-8555-555555555556');
          if (variant === 'different Products') {
            encoded = encoded.replaceAll(unitPriceFixtureProductRef.resourceId, '22222222-2222-4222-8222-222222222223');
          }
        }
        const second = yield* Schema.decodeEffect(codec)(encoded);
        if (variant === 'equal-valued distinct occurrences' && 'usedPrice' in second.exactPrice.path) {
          const { path } = second.exactPrice;
          inputs.push({
            ...second,
            exactPrice: {
              ...second.exactPrice,
              path: {
                ...path,
                usedPrice: {
                  ...path.usedPrice,
                  evidence: { ...path.usedPrice.evidence, observedAt: '2026-09-28T12:00:00.050Z' },
                },
              },
            },
          });
        } else {
          inputs.push(second);
        }
      }
      const [head, ...tail] = inputs;
      assert(head !== undefined);
      const decision = decisionFor([head.line, ...tail.map(({ line }) => line)]);
      const request = requestFor(decision);
      const attempt = attemptFor(decision);
      const trusted = trustedScopeFor(request);
      const composition = makeCurrentPricingDecisionWholeComposition();
      const questions: PricingPurposeEquivalenceRequest[] = [];
      const activeComposition = yield* makeApplicationCompositionSnapshotFixture(
        ['catalog', 'pricing'],
        'TEST:1225:build',
      );
      const external = makeCurrentPricingDecisionExternalOwnerEvidenceLivePort(
        {
          compositionRevision: activeComposition.composition.revision,
          legalEntityId: decision.commercialScope.sellingLegalEntityId,
          requestCorrelation: 'TEST:1225:whole',
          tenantId: decision.tenantId,
        },
        {
          applicationComposition: { load: Effect.succeed(activeComposition) },
          catalog: catalogContract1225(questions, inputs),
          customerContext: {
            execute: () => Effect.die('Guest must not call Profile owner'),
            issuer: { issue: () => Effect.die('Guest must not request Profile credential') },
          },
          market: {
            execute: marketContract1225,
            issuer: {
              issue: () =>
                Effect.succeed({
                  baseUrl: new URL('http://127.0.0.1:1225'),
                  credential: Redacted.make('TEST:1225:market-only'),
                }),
            },
          },
          validation: makePricingExternalOwnerEvidenceValidationService(),
        },
      );
      const feeFixture = yield* makeIssue779Scenario({ feeAmount: '3' });
      const [feeTemplate] = feeFixture.compositionRequest.feeResults;
      assert(feeTemplate?.outcome === 'COMMERCIAL_FEES_APPLIED');
      let reachedWholeConsumer = false;
      const observedGroupSizes: number[] = [];
      const qualifiedStop = new CurrentPricingDecisionOwnerReadFailure({
        kind: 'UNAVAILABLE',
        ownerRefs: ['TEST:1225:native-final-authority'],
        reason:
          'Unit contract proof ends after complete whole money and actual owner aggregate; native publication is separate evidence',
      });
      const whole = makeCurrentPricingDecisionWholeEvaluationService({
        attemptSource: {
          loadFresh: () =>
            Effect.succeed({
              attempt,
              exactPriceLines: [
                exactPriceLineFor(head, decision),
                ...tail.map((item) => exactPriceLineFor(item, decision)),
              ],
              requiredOwnerRefs: ['TEST:1225:declared-Pricing-ports'],
            }),
        },
        composition: {
          ...composition,
          buildMaterialEvidenceRequest: (input) =>
            Effect.gen(function* observeWholeConsumer1225() {
              reachedWholeConsumer = true;
              expect(Schema.is(PricingCommercialTotalReadySchema)(input.commercialTotal)).toBe(true);
              expect(input.commercialTotal.decision).toEqual(decision);
              expect(input.commercialTotal.publishedLines.map(({ occurrenceId }) => occurrenceId)).toEqual(
                inputs.map(({ line }) => line.occurrenceId),
              );
              expect(input.commercialTotal.pricingNetCommercialTotal).toEqual({
                amount: String(inputs.length * 103),
                currencyCode: 'CZK',
              });
              expect(input.commercialTotal.breakdown.commercialFeeTotal).toEqual({
                amount: String(inputs.length * 3),
                currencyCode: 'CZK',
              });
              expect(
                input.externalOwnerEvidence.retained.catalogSelections.map(({ occurrenceId }) => occurrenceId),
              ).toEqual(inputs.map(({ line }) => line.occurrenceId));
              expect(
                input.externalOwnerEvidence.fenceSources.filter(
                  ({ verificationMaterial }) => verificationMaterial.kind === 'CATALOG_EQUIVALENCE_AUTHORITY',
                ),
              ).toHaveLength(inputs.length);
              return yield* qualifiedStop;
            }),
        },
        discountReader: { loadCurrent: () => Effect.succeed({ applicabilityInputs: [], currentSets: [] }) },
        externalOwnerEvidence: external,
        feeReader: {
          loadCurrent: (_request, _attempt, unit) =>
            Effect.gen(function* declaredFeeRead1225() {
              const { line } = unit.input;
              const target = { variantRef: line.catalog.selection.variantRef };
              const predicateRef = pricingCommercialFeeCurrentSetPredicateRef({
                commercialScope: decision.commercialScope,
                currencyCode: 'CZK',
                target,
              });
              assert('usedPrice' in unit.input.exactPrice.path);
              const { usedPrice } = unit.input.exactPrice.path;
              const feeSet = {
                ...feeTemplate.input.feeSet,
                commercialScope: decision.commercialScope,
                completenessEvidence: {
                  ...feeTemplate.input.feeSet.completenessEvidence,
                  scope: { kind: 'EXACT_PREDICATE', predicateRef },
                },
                currentnessEvidence: { ...feeTemplate.input.feeSet.currentnessEvidence, predicateRef },
                fees: feeTemplate.input.feeSet.fees.map((fee) => ({
                  ...fee,
                  definition: {
                    ...fee.definition,
                    catalogTargetEvidence: {
                      ...fee.definition.catalogTargetEvidence,
                      productRef: line.catalog.selection.productRef,
                      variantRef: target.variantRef,
                    },
                    identityKey: { ...fee.definition.identityKey, commercialScope: decision.commercialScope, target },
                  },
                })),
                target,
              };
              const input = yield* Schema.decodeUnknownEffect(PricingCommercialFeeCalculationInputSchema)({
                baseLineValue: unit.baseLineValue,
                currencySupport: unit.input.exactPrice.currencySupport,
                decision,
                feeSet,
                occurrenceId: line.occurrenceId,
                pricePath: {
                  priceRef: usedPrice.priceRef,
                  priceRevisionId: usedPrice.priceRevision.revisionId,
                  source: 'NO_GROUP_PRICE',
                },
              });
              return {
                authority: {
                  generation: 1,
                  observedAt: decision.operationTime,
                  ownerRevision: feeSet.completenessEvidence.ownerRevision,
                  ownerRootRef: `TEST:1225:fee:${line.occurrenceId}`,
                  predicateRef,
                  verificationRef: `TEST:1225:fee-proof:${line.occurrenceId}`,
                },
                factProofs: [],
                input,
              };
            }).pipe(Effect.orDie),
        },
        floorReader: {
          loadCurrent: (_request, _attempt, raw) =>
            Effect.succeed(
              raw.lines.map((line) => ({
                authority: {
                  generation: 1,
                  observedAt: decision.operationTime,
                  ownerRevision: 'TEST:1225:floor-set',
                  ownerRootRef: 'TEST:1225:floor-root',
                  predicateRef: 'TEST:1225:floor-predicate',
                  verificationRef: 'TEST:1225:floor-proof',
                },
                authorizationSet: authorizationSetFor(line, { authorizations: [] }),
                factProofs: [],
                occurrenceId: line.occurrenceId,
              })),
            ),
        },
        promotionEvaluation: { evaluate: () => Effect.die('Ordinary candidate must not activate Promotion') },
        tierReader: {
          loadCurrent: (_request, _attempt, line, _price, aggregationGroup) =>
            Effect.sync(() => {
              observedGroupSizes.push(aggregationGroup.length);
              const fixture = inputs.find((item) => item.line.occurrenceId === line.line.occurrenceId);
              assert(fixture !== undefined);
              assert(fixture.tierSelection.outcome === 'BASE_PRICE_RETAINED');
              return {
                authority: fixture.tierSelection.evidence.input.tierSet.authority,
                factProofs: fixture.tierSelection.evidence.input.tierSet.factProofs,
                request: { input: fixture.tierSelection.evidence.input, outcome: 'TIER_SET_CURRENT' },
              };
            }),
        },
      });
      const result = yield* whole.loadFresh(request, trusted, 1);
      expect({
        reachedWholeConsumer,
        stage: 'reason' in result.attempt ? result.attempt.reason : result.attempt.kind,
      }).toEqual({ reachedWholeConsumer: true, stage: qualifiedStop.reason });
      expect(questions.map(({ members }) => members[0]?.occurrenceId)).toEqual(
        inputs.map(({ line }) => line.occurrenceId),
      );
      expect(result.outcome.outcome).toBe('PRICING_INDETERMINATE');
      expect(observedGroupSizes).toEqual(inputs.map(() => (variant === 'equal-valued distinct occurrences' ? 2 : 1)));
    }),
  );
}

for (const materialChange of ['none', 'Price owner revision', 'Group definition revision'] as const) {
  it.effect(
    `groups assigned Price reads by material evidence, not compatibility instants: ${materialChange} #1225`,
    () =>
      Effect.gen(function* assignedGroupCompatibilityInstants1225() {
        const first = yield* unitPriceCalculationAttempt({
          groupPath: true,
          occurrenceId: 'TEST:1225:assigned-A',
          quantity: '6',
          tiers: [{ amount: '75', revisionId: '77777777-7777-4777-8777-777777777777', thresholdQuantity: '10' }],
        });
        const second = yield* unitPriceCalculationAttempt({
          groupPath: true,
          occurrenceId: 'TEST:1225:assigned-B',
          quantity: '6',
          tiers: [{ amount: '75', revisionId: '77777777-7777-4777-8777-777777777777', thresholdQuantity: '10' }],
        });
        const path = Match.value(second.exactPrice.path).pipe(
          Match.tag('GROUP_PRICE', (assignedPath) => assignedPath),
          Match.orElse(() => null),
        );
        assert(path !== null);
        const { interpretation } = path.resolutionInput;
        const compatibility = {
          ...interpretation.compatibilityEvidence,
          definitionRevisionId:
            materialChange === 'Group definition revision'
              ? 'cccccccc-cccc-4ccc-8ccc-cccccccccccd'
              : interpretation.compatibilityEvidence.definitionRevisionId,
          verifiedAt: '2026-09-28T12:00:00.050Z',
        };
        const secondPrice = yield* Schema.decodeEffect(Schema.toType(ExactPriceResolutionSchema))({
          ...second.exactPrice,
          path: {
            ...path,
            resolutionInput: {
              ...path.resolutionInput,
              interpretation: {
                ...interpretation,
                assignmentResolution: { ...interpretation.assignmentResolution, compatibility },
                compatibilityEvidence: compatibility,
              },
            },
            usedPrice: {
              ...path.usedPrice,
              evidence: {
                ...path.usedPrice.evidence,
                ownerRevision:
                  materialChange === 'Price owner revision'
                    ? 'TEST:1225:different-price-set'
                    : path.usedPrice.evidence.ownerRevision,
              },
            },
          },
        });
        const initialDecision = decisionFor([first.line, second.line]);
        const decision: PricingDecision = {
          ...initialDecision,
          purchasingContext: {
            ...initialDecision.purchasingContext,
            actor: { kind: 'PRINCIPAL', principalId: '79000000-0000-4000-8000-000000000120' },
            subject: {
              authorizationSubject: { kind: 'RETAIL' },
              kind: 'PROFILE',
              profileRef: {
                moduleId: 'commerce.customer-context',
                resourceId: 'TEST:1225:retail-profile',
                resourceType: 'commerce.customer-context.retail-customer-profile',
                tenantId: initialDecision.tenantId,
              },
            },
          },
        };
        const request = requestFor(decision);
        const stop = new CurrentPricingDecisionOwnerReadFailure({
          kind: 'UNAVAILABLE',
          ownerRefs: ['TEST:1225:remaining-owner-prerequisites'],
          reason: 'Regression observes grouping and real Tier selection before unrelated owner reads',
        });
        let observed = false;
        const service = makeCurrentPricingDecisionWholeEvaluationService({
          attemptSource: {
            loadFresh: () =>
              Effect.succeed({
                attempt: attemptFor(decision),
                exactPriceLines: [
                  exactPriceLineFor(first, decision),
                  exactPriceLineFor({ ...second, exactPrice: secondPrice }, decision),
                ],
                requiredOwnerRefs: ['TEST:1225:declared-Pricing-ports'],
              }),
          },
          composition: unavailableComposition,
          discountReader: { loadCurrent: unexpected },
          externalOwnerEvidence: unavailableExternalOwnerEvidence,
          feeReader: { loadCurrent: unexpected },
          floorReader: { loadCurrent: unexpected },
          promotionEvaluation: { evaluate: unexpected },
          tierReader: {
            loadCurrent: (_request, _attempt, _line, _price, aggregationGroup) =>
              Effect.gen(function* observeAssignedTierGroup() {
                observed = true;
                expect(aggregationGroup).toHaveLength(materialChange === 'none' ? 2 : 1);
                for (const member of aggregationGroup) {
                  expect(member.exactPrice).toEqual(
                    member.line.line.occurrenceId === first.line.occurrenceId ? first.exactPrice : secondPrice,
                  );
                }
                assert(first.tierSelection.outcome === 'BASE_PRICE_RETAINED');
                const tierInput = first.tierSelection.evidence.input;
                const quantities = aggregationGroup.map(({ line }) => {
                  assert(line.lineQuantity !== undefined);
                  return line.lineQuantity;
                });
                const normalizedQuantity = sumQuantityTierNormalizedQuantities(quantities);
                assert(normalizedQuantity !== undefined);
                expect(normalizedQuantity.quantity).toBe(materialChange === 'none' ? '12' : '6');
                const selected = yield* selectQuantityTier({
                  input: {
                    ...tierInput,
                    attempt: {
                      ...tierInput.attempt,
                      normalizedQuantity,
                    },
                  },
                  outcome: 'TIER_SET_CURRENT',
                });
                expect(selected.outcome).toBe(
                  materialChange === 'none' ? 'QUANTITY_TIER_APPLIED' : 'BASE_PRICE_RETAINED',
                );
                return yield* stop;
              }),
          },
        });
        const result = yield* service.loadFresh(request, trustedScopeFor(request), 1);
        expect(observed).toBe(true);
        expect(result.outcome.outcome).toBe('PRICING_INDETERMINATE');
        expect(secondPrice.path).toMatchObject({
          resolutionInput: { interpretation: { compatibilityEvidence: { verifiedAt: compatibility.verifiedAt } } },
        });
      }),
  );
}
