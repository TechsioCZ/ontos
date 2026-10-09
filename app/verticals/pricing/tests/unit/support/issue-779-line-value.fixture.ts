import type {
  PricingLineCompositionRequest,
  PricingRawCompositionLine,
  PricingZeroFloorAuthorization,
  PricingZeroFloorCurrentAuthorizationSet,
} from '@app/pricing-contracts/domain/line-composition';
import type { CatalogResourceRef } from '@app/catalog/domain/catalog-revision-reference';
import { ProductUnitRefSchema } from '@app/catalog/resources/product-unit';
import type { ProductUnitRef } from '@app/catalog/resources/product-unit';
import {
  PricingCommercialFeeCalculationResultSchema,
  pricingCommercialFeeCurrentSetPredicateRef,
} from '@app/pricing-contracts/domain/commercial-fee';
import type { PricingDiscountCompositionCandidate } from '@app/pricing-contracts/domain/discount-composition';
import {
  PricingDiscountCompositionCandidateSchema,
  PricingDiscountCompositionRequestSchema,
} from '@app/pricing-contracts/domain/discount-composition';
import { PricingPromotionCompositionReadySchema } from '@app/pricing-contracts/domain/promotion-composition';
import { Effect, Schema } from 'effect';

import { composePricingDiscounts } from '../../../src/services/discount-composition.service.ts';
import { evaluatePricingLineValues } from '../../../src/services/line-value-calculation.service.ts';
import { composePricingRawLines } from '../../../src/services/line-value-composition.service.ts';
import { calculatePricingUnitPrice } from '../../../src/services/unit-price-calculation.service.ts';
import {
  unitPriceCalculationAttempt,
  unitPriceFixtureEffectiveAt,
  unitPriceFixtureTenantId,
} from './unit-price-calculation.fixture.ts';

export const occurrenceId = 'line-779';
export const candidateRef = 'pricing-candidate:779';
export const money = (amount: string, currencyCode = 'CZK') => ({ amount, currencyCode });
const fixtureEffectiveFrom = '2026-09-01T00:00:00.000Z';

export const requireIssue779ProductUnitRef = (unitRef: CatalogResourceRef): ProductUnitRef => {
  if (!Schema.is(ProductUnitRefSchema)(unitRef)) {
    throw new Error('Issue #779 fixture requires a Catalog Product Unit');
  }
  return unitRef;
};

export const makeIssue779Scenario = Effect.fn('test.makeIssue779Scenario')(function* makeIssue779Scenario(options?: {
  readonly currencyCode?: 'CZK' | 'EUR';
  readonly discounts?: readonly [catalog: string, group: string, counterparty: string];
  readonly feeAmount?: string;
  readonly occurrenceId?: string;
  readonly priceAmount?: string;
  readonly promotionAmount?: string;
}) {
  const currencyCode = options?.currencyCode ?? 'CZK';
  const priceAmount = options?.priceAmount ?? '100';
  const scenarioOccurrenceId = options?.occurrenceId ?? occurrenceId;
  const unitPrice = yield* calculatePricingUnitPrice(
    yield* unitPriceCalculationAttempt({
      currencyCode,
      groupPath: true,
      occurrenceId: scenarioOccurrenceId,
      priceAmount,
      quantity: '1',
    }),
  );
  const { input: unitPriceInput } = unitPrice;
  const { line } = unitPriceInput;
  const { path: pricePath } = unitPriceInput.exactPrice;
  if (
    !('usedPrice' in pricePath) ||
    !('discountAudience' in pricePath) ||
    !('interpretation' in pricePath.resolutionInput) ||
    pricePath.discountAudience.kind !== 'PRICE_GROUP'
  ) {
    throw new Error('Issue #779 fixture requires the exact Group Price path');
  }
  const { interpretation: priceGroupInterpretation } = pricePath.resolutionInput;
  const decision = {
    commercialScope: pricePath.usedPrice.request.exactKey.commercialScope,
    currencyCode,
    lines: [line],
    monetaryBoundary: 'PRE_TAX' as const,
    operationTime: unitPriceFixtureEffectiveAt,
    purchasingContext: {
      accessDecision: {
        decisionRef: 'purchase-context-access:779',
        decisionRevision: 'purchase-context-access-r779',
      },
      actor: {
        kind: 'PRINCIPAL' as const,
        principalId: 'pricing-principal:779',
      },
      commercialSettingsDecision: {
        decisionRef: 'purchase-commercial-settings:779',
        decisionRevision: 'purchase-commercial-settings-r779',
      },
      contextRef: 'purchase-context:779',
      contextRevision: 'purchase-context-r779',
      currencyResolution: {
        currencyCode,
        resolutionRef: 'purchase-currency-resolution:779',
        resolutionRevision: 'purchase-currency-resolution-r779',
      },
      subject: {
        authorizationSubject: { kind: 'RETAIL' as const },
        kind: 'PROFILE' as const,
        profileRef: {
          moduleId: 'commerce.customer-context' as const,
          resourceId: 'purchase-context:779',
          resourceType: 'commerce.customer-context.retail-customer-profile' as const,
          tenantId: unitPriceFixtureTenantId,
        },
      },
    },
    tenantId: unitPriceFixtureTenantId,
  };
  const { selection } = line.catalog;
  const { priceGroupRef } = pricePath.discountAudience;
  const counterpartyRef = {
    moduleId: 'party.registry' as const,
    resourceId: '10101010-1010-4101-8101-101010101010',
    resourceType: 'party.registry.counterparty' as const,
    tenantId: unitPriceFixtureTenantId,
  };
  const feeAmount = options?.feeAmount ?? '0';
  const feeTarget = { variantRef: selection.variantRef };
  const feeOwnerRevision = 'pricing-commercial-fees:779';
  const feePredicateRef = pricingCommercialFeeCurrentSetPredicateRef({
    commercialScope: decision.commercialScope,
    currencyCode,
    target: feeTarget,
  });
  const feeRevision = {
    definition: {
      catalogTargetEvidence: {
        capturedAt: decision.operationTime,
        catalogOwnerRevision: line.catalog.ownerRevision,
        productRef: selection.productRef,
        snapshotId: 'fee-catalog-snapshot:779',
        targetId: 'fee-target:779',
        variantRef: selection.variantRef,
      },
      feeRef: {
        moduleId: 'commerce.pricing' as const,
        resourceId: '20202020-2020-4202-8202-202020202020',
        resourceType: 'commerce.pricing.commercial-fee' as const,
        tenantId: unitPriceFixtureTenantId,
      },
      identityKey: {
        calculationBasis: { kind: 'FIXED_PER_LINE' as const },
        commercialScope: decision.commercialScope,
        currencyCode,
        family: 'RECYCLING_FEE' as const,
        monetaryBoundary: 'PRE_TAX' as const,
        target: feeTarget,
      },
      revision: {
        configuredAmount: money(feeAmount, currencyCode),
        effectiveFrom: fixtureEffectiveFrom,
        revision: 1,
        revisionId: '21212121-2121-4212-8212-212121212121',
      },
    },
    effectivePeriod: { effectiveFrom: fixtureEffectiveFrom, effectiveTo: null },
    lineage: { correctedRevisionId: null, kind: 'INITIAL' as const, previousRevisionId: null },
  };
  const feeSet = {
    commercialScope: decision.commercialScope,
    completenessEvidence: {
      observedAt: decision.operationTime,
      ownerRevision: feeOwnerRevision,
      scope: { kind: 'EXACT_PREDICATE' as const, predicateRef: feePredicateRef },
    },
    currencyCode,
    currentnessEvidence: {
      observedAt: decision.operationTime,
      ownerRevision: feeOwnerRevision,
      predicateRef: feePredicateRef,
      revalidatedAt: decision.operationTime,
      verificationMode: 'OWNER_CURRENT_SET_REVALIDATED' as const,
    },
    fees: feeAmount === '0' ? [] : [feeRevision],
    observedAt: decision.operationTime,
    target: feeTarget,
  };
  const feeInput = {
    baseLineValue: unitPrice.baseLineValue,
    currencySupport: unitPrice.input.exactPrice.currencySupport,
    decision,
    feeSet,
    occurrenceId: scenarioOccurrenceId,
    pricePath: {
      priceRef: pricePath.usedPrice.priceRef,
      priceRevisionId: pricePath.usedPrice.priceRevision.revisionId,
      source: 'PRICE_GROUP_PRICE' as const,
    },
  };
  const feeResult = yield* Schema.decodeEffect(PricingCommercialFeeCalculationResultSchema, {
    onExcessProperty: 'error',
  })({
    contributions:
      feeAmount === '0'
        ? []
        : [
            {
              amount: money(feeAmount, currencyCode),
              appliedQuantity: { count: '1', kind: 'LINE' },
              fee: feeRevision,
              monetaryBoundary: 'PRE_TAX',
              occurrenceId: scenarioOccurrenceId,
            },
          ],
    contributionTotal: money(feeAmount, currencyCode),
    discountableLineBasis: money((Number(priceAmount) + Number(feeAmount)).toString(), currencyCode),
    input: feeInput,
    outcome: 'COMMERCIAL_FEES_APPLIED',
  });
  if (feeResult.outcome !== 'COMMERCIAL_FEES_APPLIED') {
    throw new Error('Issue #779 fixture requires applied Fee evidence');
  }

  const lineBasis = {
    catalogSelection: selection,
    kind: 'VARIANT_LINE' as const,
    unitBasis: line.pricingBasis,
  };
  const basePricePath = {
    kind: 'PRICE_GROUP_PRICE' as const,
    priceGroupRef,
    priceRef: pricePath.usedPrice.priceRef,
    priceRevisionId: pricePath.usedPrice.priceRevision.revisionId,
  };
  const applicabilityBasis = {
    basis: lineBasis,
    commercialScope: decision.commercialScope,
    currencyCode,
    observedAt: decision.operationTime,
  };
  const definitionFor = (
    layer: 'CATALOG' | 'PRICE_GROUP_CONTRACTUAL' | 'COUNTERPARTY_CONTRACTUAL',
    level: string,
    index: number,
  ) => {
    let audience;
    if (layer === 'CATALOG') {
      audience = { kind: 'CATALOG_PATH' as const, selection };
    } else if (layer === 'PRICE_GROUP_CONTRACTUAL') {
      audience = { kind: 'PRICE_GROUP' as const, priceGroupRef };
    } else {
      audience = { counterpartyRef, kind: 'COUNTERPARTY' as const };
    }
    const identityKey = {
      audience,
      basis: lineBasis,
      commercialScope: decision.commercialScope,
      currencyCode,
      effectKind: 'FIXED_MONETARY_AMOUNT' as const,
      family: layer === 'CATALOG' ? ('CATALOG_DISCOUNT' as const) : ('CONTRACTUAL_DISCOUNT' as const),
      monetaryBoundary: 'PRE_TAX' as const,
      scope: 'VARIANT_LINE' as const,
    };
    return {
      discountId: `3${index}313131-3131-4313-8313-31313131313${index}`,
      identityKey,
      revision: {
        configuredEffect: {
          kind: 'FIXED_MONETARY_AMOUNT' as const,
          level: money(level, currencyCode),
        },
        effectiveFrom: fixtureEffectiveFrom,
        revision: 1,
        revisionId: `4${index}414141-4141-4414-8414-41414141414${index}`,
      },
    };
  };
  const candidateFor = (
    layer: 'CATALOG' | 'PRICE_GROUP_CONTRACTUAL' | 'COUNTERPARTY_CONTRACTUAL',
    level: string,
    index: number,
  ) => {
    const definition = definitionFor(layer, level, index);
    let audienceBinding;
    if (layer === 'CATALOG') {
      audienceBinding = {
        applicabilityBasis,
        basePricePath,
        evidence: {
          audience: definition.identityKey.audience,
          catalogEvidence: line.catalog.evidence,
          kind: 'CATALOG_OWNER_EVIDENCE' as const,
        },
        identityKey: definition.identityKey,
      };
    } else if (layer === 'PRICE_GROUP_CONTRACTUAL') {
      audienceBinding = {
        applicabilityBasis,
        basePricePath,
        evidence: {
          audience: definition.identityKey.audience,
          interpretation: priceGroupInterpretation,
          kind: 'PRICE_GROUP_OWNER_EVIDENCE' as const,
        },
        identityKey: definition.identityKey,
      };
    } else {
      audienceBinding = {
        applicabilityBasis,
        basePricePath,
        evidence: {
          audience: definition.identityKey.audience,
          kind: 'COUNTERPARTY_OWNER_EVIDENCE' as const,
          observedAt: decision.operationTime,
          ownerRevision: 'party-registry:779',
          source: 'PARTY_REGISTRY' as const,
        },
        identityKey: definition.identityKey,
      };
    }
    return Schema.decodeUnknownEffect(PricingDiscountCompositionCandidateSchema, {
      onExcessProperty: 'error',
    })({
      applicationCount: 'ONCE_PER_STABLE_LINE',
      audienceBinding,
      definition,
      kind: 'VARIANT_LINE',
      layer,
      occurrenceId: scenarioOccurrenceId,
      outcome: 'DISCOUNT_APPLICABLE',
    });
  };
  const [catalog, group, counterparty] = options?.discounts ?? ['10', '10', '10'];
  const candidates: readonly PricingDiscountCompositionCandidate[] = yield* Effect.all([
    candidateFor('CATALOG', catalog, 1),
    candidateFor('PRICE_GROUP_CONTRACTUAL', group, 2),
    candidateFor('COUNTERPARTY_CONTRACTUAL', counterparty, 3),
  ]);
  const discountableAmount = (Number(priceAmount) + Number(feeAmount)).toString();
  const discountRequest = yield* Schema.decodeEffect(PricingDiscountCompositionRequestSchema, {
    onExcessProperty: 'error',
  })({
    candidates,
    currencySupport: unitPrice.input.exactPrice.currencySupport,
    decision,
    lineBases: [
      {
        amount: money(discountableAmount, currencyCode),
        applicablePricingFeeTotal: money(feeAmount, currencyCode),
        baseLineValue: unitPrice.baseLineValue,
        occurrenceId: scenarioOccurrenceId,
      },
    ],
  });
  const discountComposition = yield* composePricingDiscounts(discountRequest);
  if (discountComposition.outcome !== 'DISCOUNT_COMPOSITION_READY') {
    throw new Error('Issue #779 fixture requires a ready Discount composition');
  }
  const prePromotionAmount = (
    Number(priceAmount) +
    Number(feeAmount) -
    Number(catalog) -
    Number(group) -
    Number(counterparty)
  ).toString();
  const promotionAmount = options?.promotionAmount;
  const rawAmount = (Number(prePromotionAmount) + Number(promotionAmount ?? '0')).toString();
  const subjectEvidence = {
    evidenceRef: 'subject-evidence:779',
    observedAt: decision.operationTime,
    ownerModuleId: 'commerce.customer-context',
    ownerRevision: 'subject-r779',
    provenanceRef: 'subject-proof:779',
    revalidatedAt: decision.operationTime,
    subject: { guestEvidenceRef: 'guest-session:779', kind: 'GUEST' as const, tenantId: unitPriceFixtureTenantId },
  };
  const exactPredicateRef = 'promotion-candidate:779';
  const ownerEvidence = {
    completenessEvidence: {
      nextApplicabilityBoundary: '2026-09-28T13:00:00.000Z',
      observedAt: decision.operationTime,
      ownerRevision: 'promotion-r779',
      scope: { kind: 'EXACT_PREDICATE' as const, predicateRef: exactPredicateRef },
    },
    currentness: {
      evaluatedAt: decision.operationTime,
      observedAt: decision.operationTime,
      revalidatedAt: decision.operationTime,
      status: 'CURRENT' as const,
    },
    exactPredicateRef,
    ownerModuleId: 'commerce.promotion' as const,
    ownerRevision: 'promotion-r779',
    provenanceRef: 'promotion-proof:779',
  };
  const acceptedRequest = {
    applicationRequestRef: 'promotion-request:779',
    candidateRef,
    exactPredicateRef,
    subjectEvidence,
  };
  const promotion =
    promotionAmount === undefined
      ? {
          acceptedRequest,
          outcome: 'PROMOTION_NOT_APPLICABLE' as const,
          ownerDecisionRevision: ownerEvidence.ownerRevision,
          ownerEvidence,
          reason: 'NO_APPLICABLE_APPLICATION' as const,
        }
      : {
          acceptedRequest,
          allocations: [
            {
              amount: money(promotionAmount, currencyCode),
              catalogSelection: selection,
              occurrenceId: scenarioOccurrenceId,
              recipientKind: 'MERCHANDISE' as const,
            },
          ],
          applicationIdentity: {
            applicationKind: 'PROMOTION_APPLICATION' as const,
            applicationRef: 'promotion-application:779',
            applicationRevision: 'promotion-application-r779',
            originalApplicationRef: acceptedRequest.applicationRequestRef,
          },
          contribution: money(promotionAmount, currencyCode),
          outcome: 'PROMOTION_APPLIED' as const,
          ownerDecisionRevision: ownerEvidence.ownerRevision,
          ownerEvidence,
          shippingAllocations: [],
          target: { kind: 'MERCHANDISE_ONLY' as const, occurrenceIds: [scenarioOccurrenceId] },
        };
  const promotionAllocation = promotion.outcome === 'PROMOTION_APPLIED' ? promotion.allocations[0] : undefined;
  const promotionLine = {
    catalogSelection: selection,
    occurrenceId: scenarioOccurrenceId,
    prePromotionValue: money(prePromotionAmount, currencyCode),
    rawPreTaxValue: money(rawAmount, currencyCode),
    recipientKind: 'MERCHANDISE',
  };
  const promotionComposition = yield* Schema.decodeUnknownEffect(PricingPromotionCompositionReadySchema, {
    onExcessProperty: 'error',
  })({
    candidateRef,
    completedPricingAllocationRefs: ['pricing-composition:779'],
    currentnessEvidence: {
      applicationRequestRef: acceptedRequest.applicationRequestRef,
      candidateRef,
      currencySupport: {
        currencyCode,
        evidenceRef: 'currency-support:779',
        observedAt: decision.operationTime,
        ownerRevision: 'currency-support-r779',
        status: 'SUPPORTED_CURRENT',
        tenantId: unitPriceFixtureTenantId,
      },
      exactPredicateRef,
      ownerEvidence,
      pricingCompositionRef: 'pricing-composition:779',
      pricingCompositionRevision: 'pricing-composition-r779',
      subjectEvidence,
    },
    decision,
    lines: [promotionAllocation === undefined ? promotionLine : { ...promotionLine, promotionAllocation }],
    outcome: 'PROMOTION_COMPOSITION_READY',
    promotion,
    stage: 'AFTER_PRICE_TIER_FEES_ALL_PRICING_DISCOUNTS_AND_PROMOTION',
  });
  const compositionRequest: PricingLineCompositionRequest = {
    candidateRef,
    decision,
    discountComposition,
    feeResults: [feeResult],
    promotionComposition: { composition: promotionComposition, kind: 'PROMOTION_SELECTED' },
    unitPrices: [unitPrice],
  };
  return { compositionRequest, counterpartyRef, feeRevision, priceGroupRef, unitPrice };
});

export const authorizationSetFor = (
  line: PricingRawCompositionLine,
  options?: {
    readonly authorizations?: readonly PricingZeroFloorAuthorization[];
    readonly nextBoundary?: string;
    readonly observedAt?: string;
    readonly ownerRevision?: string;
  },
): PricingZeroFloorCurrentAuthorizationSet => {
  const ownerRevision = options?.ownerRevision ?? 'zero-floor-set-r779';
  const observedAt = options?.observedAt ?? unitPriceFixtureEffectiveAt;
  const exactPredicateRef = 'zero-floor:exact:779';
  const exactPricePath = line.unitPriceCalculation.input.exactPrice.path;
  if (!('usedPrice' in exactPricePath)) {
    throw new Error('Expected exact Price evidence in ZERO_FLOOR fixture');
  }
  const materialRevisionRefs = [
    exactPricePath.usedPrice.priceRevision.revisionId,
    ...line.feeCalculation.contributions.map(({ fee }) => fee.definition.revision.revisionId),
    ...line.lineDiscountContributions.map(({ candidate }) => candidate.definition.revision.revisionId),
    ...(line.wholePurchaseAllocationRevisionRef === undefined ? [] : [line.wholePurchaseAllocationRevisionRef]),
    ...(line.promotionOwnerDecisionRevision === undefined ? [] : [line.promotionOwnerDecisionRevision]),
  ];
  const { decision } = line.feeCalculation.input;
  const authorization: PricingZeroFloorAuthorization = {
    authorizationRef: 'zero-floor-auth:779',
    authorizationRevision: 'zero-floor-auth-r779',
    businessScope: {
      catalogSelection: line.line.catalog.selection,
      commercialScope: decision.commercialScope,
      pricingBasis: line.line.pricingBasis,
      tenantId: decision.tenantId,
    },
    coveredMeaning: {
      audienceRefs: [
        decision.purchasingContext.contextRef,
        decision.purchasingContext.contextRevision,
        '66666666-6666-4666-8666-666666666666',
      ],
      materialRevisionRefs,
    },
    currencyCode: decision.currencyCode,
    economicCoverage: { maximumFloorAdjustment: '20', minimumRawAmount: '-20' },
    effectivePeriod: {
      endsAt: '2026-09-29T00:00:00.000Z',
      startsAt: '2026-09-28T00:00:00.000Z',
    },
    governanceEvidence: {
      approvalEvidenceRef: 'pricing-governance-proof:779',
      approvedByPrincipalRef: 'pricing-governance:779',
      reason: 'Approved bounded launch composition',
    },
  };
  const completenessEvidenceBase = {
    observedAt,
    ownerRevision,
    scope: { kind: 'EXACT_PREDICATE' as const, predicateRef: exactPredicateRef },
  };
  const completenessEvidence =
    options?.nextBoundary === undefined
      ? completenessEvidenceBase
      : { ...completenessEvidenceBase, nextApplicabilityBoundary: options.nextBoundary };
  return {
    authorizations: options?.authorizations ?? [authorization],
    completenessEvidence,
    currentness: {
      evaluatedAt: unitPriceFixtureEffectiveAt,
      observedAt,
      revalidatedAt: observedAt,
      status: 'CURRENT',
    },
    exactPredicateRef,
    ownerRevision,
    query: {
      audienceRefs: authorization.coveredMeaning.audienceRefs,
      catalogSelection: authorization.businessScope.catalogSelection,
      commercialScope: authorization.businessScope.commercialScope,
      currencyCode: authorization.currencyCode,
      effectiveAt: unitPriceFixtureEffectiveAt,
      exactPredicateRef,
      materialRevisionRefs,
      pricingBasis: authorization.businessScope.pricingBasis,
      tenantId: authorization.businessScope.tenantId,
    },
  };
};

export const firstRawLine = (lines: readonly PricingRawCompositionLine[]): PricingRawCompositionLine => {
  const [line] = lines;
  if (line === undefined) {
    throw new Error('Expected one preserved Pricing Line');
  }
  return line;
};

export const makeIssue779PreRoundScenario = Effect.fn('test.makeIssue779PreRoundScenario')(
  function* makeIssue779PreRoundScenario(options?: Parameters<typeof makeIssue779Scenario>[0]) {
    const fixture = yield* makeIssue779Scenario(options);
    const raw = yield* composePricingRawLines(fixture.compositionRequest);
    if (raw.outcome !== 'RAW_COMPOSITION_READY') {
      throw new Error('Issue #779 pre-round fixture requires ready raw composition');
    }
    const rawLine = firstRawLine(raw.lines);
    const authorizationSet = authorizationSetFor(rawLine);
    const preRound = yield* evaluatePricingLineValues({
      authorizationSets: [{ authorizationSet, occurrenceId: rawLine.occurrenceId }],
      composition: raw,
    });
    if (!('outcome' in preRound) || preRound.outcome !== 'PRE_ROUND_LINE_VALUES_READY') {
      throw new Error('Issue #779 pre-round fixture requires ready final line values');
    }
    return { authorizationSet, fixture, preRound };
  },
);
