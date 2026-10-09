import { PRICING_CZK_PUBLICATION_PROFILE } from '@app/pricing-contracts/domain/exact-decimal';
import type { PricingMaterialEvidenceReady } from '@app/pricing-contracts/domain/material-evidence';
import type {
  PricingSourceEvidenceFamily,
  PricingSourceEvidenceResult,
  PricingSourceEvidenceVerifiedPresent,
} from '@app/pricing-contracts/domain/source-revision-evidence';
import { Effect, Schema } from 'effect';
import { describe, expect, it } from 'effect-rstest';

import { calculatePricingCommercialTotals } from '../../src/services/commercial-totals.service.ts';
import {
  PricingSourceEvidenceProjectionUnverifiable,
  handoffPricingSourceEvidenceToAuthorizedInternalConsumer,
  projectPricingMaterialEvidenceForCustomer,
} from '../../src/services/source-evidence-projection.service.ts';
import { candidateRef, makeIssue779PreRoundScenario, money } from './support/issue-779-line-value.fixture.ts';

const encodeJson = Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown));

const readyCommercialTotal = Effect.fn('test.readyCommercialTotalForEvidenceProjection')(
  function* readyCommercialTotalProgram() {
    const { preRound } = yield* makeIssue779PreRoundScenario({
      feeAmount: '10',
      promotionAmount: '-10',
    });
    const [line] = preRound.lines;
    if (line === undefined) {
      return yield* Effect.die('The #779 fixture must preserve one pre-round line');
    }

    const result = yield* calculatePricingCommercialTotals({
      candidateRef,
      decision: preRound.decision,
      preRound,
      publishedLines: [
        {
          occurrenceId: line.occurrenceId,
          publicationProfile: PRICING_CZK_PUBLICATION_PROFILE,
          publishedLineValue: line.nonNegativePreRoundValue,
          roundingAdjustment: money('0'),
        },
      ],
    });
    if (result.outcome === 'COMMERCIAL_TOTAL_FAILED') {
      const encodedResult = yield* encodeJson(result);
      return yield* Effect.die(encodedResult);
    }
    return result;
  },
);

const sourceEvidenceFor = (
  commercialTotal: Effect.Success<ReturnType<typeof readyCommercialTotal>>,
  family: PricingSourceEvidenceFamily,
  ownerModuleId = 'commerce.pricing',
): PricingSourceEvidenceVerifiedPresent => {
  const { currencyCode, operationTime, tenantId } = commercialTotal.decision;
  const observedAt = '2026-09-28T12:00:01.000Z';
  const familyKey = family.toLowerCase().replace('_', '-');
  const predicateRef = `pricing:${familyKey}:exact-predicate:projection`;
  const ownerScope = {
    ownerModuleId,
    ownerRootRef: `pricing:${familyKey}-root:projection`,
    predicateRef,
    tenantId,
  } as const;
  const temporal = {
    effectiveAt: operationTime,
    evaluatedAt: operationTime,
    evaluationMode: 'HISTORICAL_AS_OF' as const,
    observedAt,
    requestedAt: operationTime,
  };
  const verification = {
    kind: 'OWNER_VERIFIABLE_OPAQUE_REFERENCE' as const,
    verificationRef: 'pricing:owner-proof:private:projection',
  };

  return {
    _tag: 'VERIFIED_PRESENT',
    completeness: {
      completenessEvidence: {
        observedAt,
        ownerRevision: 'pricing:price-set-revision:projection',
        scope: { kind: 'EXACT_PREDICATE', predicateRef },
      },
      currencyCode,
      family,
      ownerScope,
      ownerSetRevisionRef: 'pricing:price-set-revision:projection',
      temporal,
      verification,
    },
    currentFacts: [
      {
        currencyCode,
        effectivePeriod: { effectiveFrom: '2026-09-01T00:00:00.000Z', effectiveTo: null },
        factRef: `pricing:${familyKey}:projection`,
        factRevisionRef: `pricing:${familyKey}-revision:projection`,
        family,
        ownerScope,
        temporal,
        verification,
      },
    ],
    request: {
      currencyCode,
      effectiveAt: operationTime,
      family,
      ownerScope,
      requestedAt: operationTime,
    },
  };
};

const materialEvidenceFor = (
  commercialTotal: Effect.Success<ReturnType<typeof readyCommercialTotal>>,
): PricingMaterialEvidenceReady => {
  const requestedAt = commercialTotal.decision.operationTime;
  const validatedAt = '2026-09-28T12:00:01.000Z';
  const subject = {
    authorizationSubject: { kind: 'RETAIL' as const },
    kind: 'PROFILE' as const,
    profileRef: {
      moduleId: 'commerce.customer-context',
      resourceId: 'retail-profile:projection',
      resourceType: 'commerce.customer-context.retail-customer-profile' as const,
      tenantId: commercialTotal.decision.tenantId,
    },
  };
  const externalOwnerEvidence = {
    candidateRef: commercialTotal.candidateRef,
    catalogSelections: commercialTotal.decision.lines.map(({ occurrenceId }) => ({
      occurrenceId,
      sourceEvidence: sourceEvidenceFor(commercialTotal, 'COMMERCIAL_CONTEXT', 'commerce.catalog'),
    })),
    decision: commercialTotal.decision,
    market: sourceEvidenceFor(commercialTotal, 'COMMERCIAL_CONTEXT', 'commerce.market-catalog'),
    priceGroupAssignment: sourceEvidenceFor(commercialTotal, 'COMMERCIAL_CONTEXT', 'commerce.customer-context'),
    promotion: {
      kind: 'PROMOTION_SELECTED',
      sourceEvidence: sourceEvidenceFor(commercialTotal, 'PROMOTION', 'commerce.promotion'),
    },
    requestedAt,
    subject,
    validatedAt,
  } as const;
  return {
    calculationVersions: commercialTotal.calculationVersions,
    candidateRef: commercialTotal.candidateRef,
    externalOwnerEvidence,
    outcome: 'PRICING_MATERIAL_EVIDENCE_READY',
    sourceEvidence: {
      commercialTotal,
      currencySupport: sourceEvidenceFor(commercialTotal, 'CURRENCY_SUPPORT'),
      externalOwnerEvidence,
      lines: commercialTotal.decision.lines.map(({ occurrenceId }) => ({
        commercialFees: sourceEvidenceFor(commercialTotal, 'COMMERCIAL_FEE'),
        lineDiscounts: {
          kind: 'DISCOUNT_SELECTED',
          sourceEvidence: sourceEvidenceFor(commercialTotal, 'DISCOUNT'),
        },
        occurrenceId,
        pricePath: { usedPrice: sourceEvidenceFor(commercialTotal, 'PRICE') },
        quantityTiers: sourceEvidenceFor(commercialTotal, 'QUANTITY_TIER'),
      })),
      requestedAt,
      revalidatedAt: validatedAt,
      wholePurchase: {
        contractualDiscounts: {
          kind: 'DISCOUNT_SELECTED',
          sourceEvidence: sourceEvidenceFor(commercialTotal, 'DISCOUNT'),
        },
      },
    },
    validatedAt,
  };
};

describe('Pricing source-evidence visibility projection', () => {
  it.effect('retains complete owner-verifiable evidence for an authorization-gated internal handoff', () =>
    Effect.gen(function* retainsInternalEvidence() {
      const commercialTotal = yield* readyCommercialTotal();
      const materialEvidence = materialEvidenceFor(commercialTotal);
      const handoff = yield* handoffPricingSourceEvidenceToAuthorizedInternalConsumer(materialEvidence);

      expect(handoff).toEqual({
        materialEvidence,
        visibility: 'AUTHORIZED_INTERNAL',
      });
      const serializedHandoff = yield* encodeJson(handoff);
      expect(serializedHandoff).toContain('pricing:owner-proof:private:projection');
      expect(serializedHandoff).toContain('pricing:price-revision:projection');
      expect(handoff.materialEvidence.sourceEvidence.lines[0]?.pricePath.usedPrice).toMatchObject({
        completeness: {
          temporal: {
            effectiveAt: commercialTotal.decision.operationTime,
            observedAt: '2026-09-28T12:00:01.000Z',
            requestedAt: commercialTotal.decision.operationTime,
          },
        },
      });
    }),
  );

  it.effect('uses a customer allowlist that preserves published amounts and omits every owner proof', () =>
    Effect.gen(function* redactsCustomerEvidence() {
      const commercialTotal = yield* readyCommercialTotal();
      const materialEvidence = materialEvidenceFor(commercialTotal);
      const customer = yield* projectPricingMaterialEvidenceForCustomer(materialEvidence);
      const serialized = yield* encodeJson(customer);

      expect(customer).toEqual({
        candidateRef: commercialTotal.candidateRef,
        currencyCode: 'CZK',
        lines: commercialTotal.publishedLines.map(({ occurrenceId, publishedLineValue }) => ({
          occurrenceId,
          publishedLineValue,
        })),
        monetaryBoundary: 'PRE_TAX',
        pricingNetCommercialTotal: commercialTotal.pricingNetCommercialTotal,
      });
      expect(customer.pricingNetCommercialTotal).toEqual(money('70'));
      expect(serialized).not.toContain('sourceEvidence');
      expect(serialized).not.toContain('verificationRef');
      expect(serialized).not.toContain('ownerSetRevisionRef');
      expect(serialized).not.toContain('factRevisionRef');
      expect(serialized).not.toContain('observedAt');
      expect(serialized).not.toContain('pricing:owner-proof:private:projection');
    }),
  );

  it.effect('fails closed on invalid aggregates or non-verifiable evidence instead of weakening the handoff', () =>
    Effect.gen(function* rejectsUnboundEvidence() {
      const commercialTotal = yield* readyCommercialTotal();
      const materialEvidence = materialEvidenceFor(commercialTotal);
      const sourceEvidence = sourceEvidenceFor(commercialTotal, 'CURRENCY_SUPPORT');
      const unavailable = {
        _tag: 'UNVERIFIABLE',
        observedAt: '2026-09-28T12:00:01.000Z',
        reason: 'OWNER_UNAVAILABLE',
        request: sourceEvidence.request,
        retryable: true,
      } as const satisfies PricingSourceEvidenceResult;
      const incomplete: PricingMaterialEvidenceReady = {
        ...materialEvidence,
        sourceEvidence: { ...materialEvidence.sourceEvidence, currencySupport: unavailable },
      };
      const wrongCandidate: PricingMaterialEvidenceReady = {
        ...materialEvidence,
        candidateRef: 'different-candidate',
      };

      for (const evidence of [incomplete, wrongCandidate]) {
        const failure = yield* Effect.flip(handoffPricingSourceEvidenceToAuthorizedInternalConsumer(evidence));
        expect(failure).toBeInstanceOf(PricingSourceEvidenceProjectionUnverifiable);
        expect(failure.retryable).toBe(true);
      }

      const customerFailure = yield* Effect.flip(projectPricingMaterialEvidenceForCustomer(incomplete));
      expect(customerFailure).toMatchObject({ code: 'PROJECTION_UNVERIFIABLE', retryable: true });
      expect(customerFailure.reason).not.toContain('OWNER_UNAVAILABLE');
    }),
  );
});
