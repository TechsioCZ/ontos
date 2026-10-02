import { PricingMaterialEvidenceReadySchema } from '@app/pricing-contracts/domain/material-evidence';
import type { PricingCommercialTotalReady } from '@app/pricing-contracts/domain/commercial-total';
import type {
  PricingSourceEvidenceFamily,
  PricingSourceEvidenceVerifiedPresent,
} from '@app/pricing-contracts/domain/source-revision-evidence';
import { Schema } from 'effect';

const pricingOwnerModuleId = 'commerce.pricing';

const sourceEvidenceFor = (
  commercialTotal: PricingCommercialTotalReady,
  family: PricingSourceEvidenceFamily,
  ownerModuleId: string,
  observedAt: string,
): PricingSourceEvidenceVerifiedPresent => {
  const { currencyCode, operationTime, tenantId } = commercialTotal.decision;
  const familyKey = family.toLowerCase().replace('_', '-');
  const predicateRef = `pricing:${familyKey}:quotation-fixture-predicate`;
  const ownerScope = {
    ownerModuleId,
    ownerRootRef: `pricing:${familyKey}:quotation-fixture-root`,
    predicateRef,
    tenantId,
  } as const;
  const temporal = {
    effectiveAt: operationTime,
    evaluatedAt: operationTime,
    evaluationMode: 'CURRENT_AT_OWNER_EVALUATION' as const,
    observedAt,
    requestedAt: operationTime,
  };
  const verification = {
    kind: 'OWNER_VERIFIABLE_OPAQUE_REFERENCE' as const,
    verificationRef: `pricing:${familyKey}:quotation-fixture-proof`,
  };
  return {
    _tag: 'VERIFIED_PRESENT',
    completeness: {
      completenessEvidence: {
        observedAt,
        ownerRevision: `pricing:${familyKey}:quotation-fixture-set-revision`,
        scope: { kind: 'EXACT_PREDICATE', predicateRef },
      },
      currencyCode,
      family,
      ownerScope,
      ownerSetRevisionRef: `pricing:${familyKey}:quotation-fixture-set-revision`,
      temporal,
      verification,
    },
    currentFacts: [
      {
        currencyCode,
        effectivePeriod: { effectiveFrom: '2026-09-01T00:00:00.000Z', effectiveTo: null },
        factRef: `pricing:${familyKey}:quotation-fixture-fact`,
        factRevisionRef: `pricing:${familyKey}:quotation-fixture-revision`,
        family,
        ownerScope,
        temporal,
        verification,
      },
    ],
    request: { currencyCode, effectiveAt: operationTime, family, ownerScope, requestedAt: operationTime },
  };
};

export const makeQuotationMaterialEvidence = (
  commercialTotal: PricingCommercialTotalReady,
  validatedAt = commercialTotal.decision.operationTime,
) => {
  const requestedAt = commercialTotal.decision.operationTime;
  const subject = {
    guestEvidenceRef: 'guest-evidence:quotation-fixture',
    guestSessionRef: 'guest-session:quotation-fixture',
    kind: 'GUEST' as const,
  };
  const externalOwnerEvidence = {
    candidateRef: commercialTotal.candidateRef,
    catalogSelections: commercialTotal.decision.lines.map(({ occurrenceId }) => ({
      occurrenceId,
      sourceEvidence: sourceEvidenceFor(commercialTotal, 'COMMERCIAL_CONTEXT', 'commerce.catalog', validatedAt),
    })),
    decision: commercialTotal.decision,
    market: sourceEvidenceFor(commercialTotal, 'COMMERCIAL_CONTEXT', 'commerce.market-catalog', validatedAt),
    promotion: {
      kind: 'PROMOTION_SELECTED',
      sourceEvidence: sourceEvidenceFor(commercialTotal, 'PROMOTION', 'commerce.promotion', validatedAt),
    },
    requestedAt,
    subject,
    validatedAt,
  };
  return Schema.decodeSync(PricingMaterialEvidenceReadySchema, { onExcessProperty: 'error' })({
    calculationVersions: commercialTotal.calculationVersions,
    candidateRef: commercialTotal.candidateRef,
    externalOwnerEvidence,
    outcome: 'PRICING_MATERIAL_EVIDENCE_READY',
    sourceEvidence: {
      commercialTotal,
      currencySupport: sourceEvidenceFor(commercialTotal, 'CURRENCY_SUPPORT', pricingOwnerModuleId, validatedAt),
      externalOwnerEvidence,
      lines: commercialTotal.decision.lines.map(({ occurrenceId }) => ({
        commercialFees: sourceEvidenceFor(commercialTotal, 'COMMERCIAL_FEE', pricingOwnerModuleId, validatedAt),
        lineDiscounts: {
          kind: 'DISCOUNT_SELECTED',
          sourceEvidence: sourceEvidenceFor(commercialTotal, 'DISCOUNT', pricingOwnerModuleId, validatedAt),
        },
        occurrenceId,
        pricePath: { usedPrice: sourceEvidenceFor(commercialTotal, 'PRICE', pricingOwnerModuleId, validatedAt) },
        quantityTiers: sourceEvidenceFor(commercialTotal, 'QUANTITY_TIER', pricingOwnerModuleId, validatedAt),
      })),
      requestedAt,
      revalidatedAt: validatedAt,
      wholePurchase: {
        contractualDiscounts: {
          kind: 'DISCOUNT_SELECTED',
          sourceEvidence: sourceEvidenceFor(commercialTotal, 'DISCOUNT', pricingOwnerModuleId, validatedAt),
        },
      },
    },
    validatedAt,
  });
};
