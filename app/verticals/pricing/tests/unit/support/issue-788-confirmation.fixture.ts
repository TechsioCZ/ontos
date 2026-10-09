import type {
  PricingCommitmentConfirmationAuthenticityProof,
  PricingCommitmentConfirmationBinding,
  PricingCommitmentConfirmationIssued,
  PricingCurrentBackedConfirmationSource,
  PricingQuotationBackedConfirmationSource,
} from '@app/pricing-contracts/domain/commitment-confirmation';
import { PricingCommitmentConfirmationIssuedSchema } from '@app/pricing-contracts/domain/commitment-confirmation';
import { PRICING_CZK_PUBLICATION_PROFILE_VERSION } from '@app/pricing-contracts/domain/exact-decimal';
import type { PricingMaterialEvidenceReady } from '@app/pricing-contracts/domain/material-evidence';
import type {
  PricingEvaluationAttempt,
  PricingMaterialStateSnapshot,
} from '@app/pricing-contracts/domain/material-change';
import {
  PricingQuotationBindingSchema,
  PricingQuotationIssuedSchema,
  PricingQuotationValiditySchema,
} from '@app/pricing-contracts/domain/quotation';
import type {
  PricingQuotationAuthenticityVerificationEvidence,
  PricingQuotationBinding,
  PricingQuotationExactReuse,
  PricingQuotationIssued,
} from '@app/pricing-contracts/domain/quotation';
import type {
  PricingSourceEvidenceFamily,
  PricingSourceEvidenceVerifiedPresent,
} from '@app/pricing-contracts/domain/source-revision-evidence';
import { Effect, Schema } from 'effect';

import { calculatePricingCommercialTotals } from '../../../src/services/commercial-totals.service.ts';
import { publishPricingLineValues } from '../../../src/services/line-value-publication.service.ts';
import {
  candidateRef as issue779CandidateRef,
  makeIssue779PreRoundScenario as issue779Scenario,
  requireIssue779ProductUnitRef,
} from './issue-779-line-value.fixture.ts';

export const issue788IssuedAt = '2026-09-28T12:00:00.000Z';
export const issue788ExpiresAt = '2026-09-28T12:00:30.000Z';
export const issue788QuoteValidUntil = '2026-09-28T12:05:00.000Z';
const pricingOwnerModuleId = 'commerce.pricing';

const decodeQuotationBinding = Schema.decodeSync(PricingQuotationBindingSchema, {
  onExcessProperty: 'error',
});

const decodeQuotationValidity = Schema.decodeSync(PricingQuotationValiditySchema, {
  onExcessProperty: 'error',
});

const decodeQuotation = Schema.decodeSync(PricingQuotationIssuedSchema, {
  onExcessProperty: 'error',
});

export const makeIssue788CommercialTotal = Effect.fn('test.issue788CommercialTotal')(function* issue788CommercialTotal(
  priceAmount = '900',
) {
  const { preRound } = yield* issue779Scenario({
    discounts: ['0', '0', '0'],
    feeAmount: '0',
    priceAmount,
    promotionAmount: '0',
  });
  const publication = yield* publishPricingLineValues({
    candidateRef: issue779CandidateRef,
    decision: preRound.decision,
    preRound,
    publicationProfileVersion: PRICING_CZK_PUBLICATION_PROFILE_VERSION,
  });
  if (publication.outcome !== 'LINE_VALUES_PUBLISHED') {
    return yield* Effect.die(`Issue #788 fixture could not publish its line: ${publication.failure.code}`);
  }
  const result = yield* calculatePricingCommercialTotals({
    candidateRef: issue779CandidateRef,
    decision: preRound.decision,
    preRound,
    publishedLines: publication.publishedLines,
  });
  if (result.outcome !== 'COMMERCIAL_TOTAL_READY') {
    return yield* Effect.die(`Issue #788 fixture could not calculate its total: ${result.failure.code}`);
  }
  return result;
});

type Issue788CommercialTotal = Effect.Success<ReturnType<typeof makeIssue788CommercialTotal>>;

export const makeIssue788PurchaseBinding = (commercialTotal: Issue788CommercialTotal): PricingQuotationBinding =>
  decodeQuotationBinding({
    candidateRef: commercialTotal.candidateRef,
    commercialScope: commercialTotal.decision.commercialScope,
    currencyCode: commercialTotal.decision.currencyCode,
    lines: commercialTotal.decision.lines.map(({ catalog, occurrenceId }) => ({
      occurrenceId,
      quantity: { amount: catalog.quantity.resulting, unitRef: requireIssue779ProductUnitRef(catalog.unitRef) },
      selection: catalog.selection,
    })),
    monetaryBoundary: commercialTotal.decision.monetaryBoundary,
    subject: {
      guestEvidenceRef: 'guest-evidence:788:a',
      guestSessionRef: 'guest-session:788:a',
      kind: 'GUEST',
      purchaseContext: {
        contextRef: commercialTotal.decision.purchasingContext.contextRef,
        contextRevision: commercialTotal.decision.purchasingContext.contextRevision,
      },
    },
    tenantId: commercialTotal.decision.tenantId,
  });

export const makeIssue788Binding = (
  commercialTotal: Issue788CommercialTotal,
): PricingCommitmentConfirmationBinding => ({
  attemptRef: 'order-commitment-attempt:788:a',
  decisionBundleHash: 'sha256:bundle-788-a',
  decisionBundleRef: 'order-decision-bundle:788:a',
  decisionBundleVersion: '1',
  purchase: makeIssue788PurchaseBinding(commercialTotal),
});

const makeSourceEvidence = (
  commercialTotal: Issue788CommercialTotal,
  family: PricingSourceEvidenceFamily,
  ownerModuleId = 'commerce.pricing',
  observedAt = issue788IssuedAt,
): PricingSourceEvidenceVerifiedPresent => {
  const { currencyCode, operationTime, tenantId } = commercialTotal.decision;
  const familyKey = family.toLowerCase().replace('_', '-');
  const predicateRef = `pricing:${familyKey}:exact-predicate:788`;
  const ownerScope = {
    ownerModuleId,
    ownerRootRef: `pricing:${familyKey}:root:788`,
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
    verificationRef: `pricing:${familyKey}:owner-proof:788`,
  };
  return {
    _tag: 'VERIFIED_PRESENT',
    completeness: {
      completenessEvidence: {
        observedAt,
        ownerRevision: `pricing:${familyKey}:set-revision:788`,
        scope: { kind: 'EXACT_PREDICATE', predicateRef },
      },
      currencyCode,
      family,
      ownerScope,
      ownerSetRevisionRef: `pricing:${familyKey}:set-revision:788`,
      temporal,
      verification,
    },
    currentFacts: [
      {
        currencyCode,
        effectivePeriod: { effectiveFrom: '2026-09-01T00:00:00.000Z', effectiveTo: null },
        factRef: `pricing:${familyKey}:fact:788`,
        factRevisionRef: `pricing:${familyKey}:revision:788`,
        family,
        ownerScope,
        temporal,
        verification,
      },
    ],
    request: { currencyCode, effectiveAt: operationTime, family, ownerScope, requestedAt: operationTime },
  };
};

export const makeIssue788MaterialEvidence = (
  commercialTotal: Issue788CommercialTotal,
  validatedAt = issue788IssuedAt,
): PricingMaterialEvidenceReady => {
  const requestedAt = commercialTotal.decision.operationTime;
  const subject = {
    authorizationSubject: { kind: 'RETAIL' as const },
    kind: 'PROFILE' as const,
    profileRef: {
      moduleId: 'commerce.customer-context' as const,
      resourceId: commercialTotal.decision.purchasingContext.contextRef,
      resourceType: 'commerce.customer-context.retail-customer-profile' as const,
      tenantId: commercialTotal.decision.tenantId,
    },
  };
  const externalOwnerEvidence = {
    candidateRef: commercialTotal.candidateRef,
    catalogSelections: commercialTotal.decision.lines.map(({ occurrenceId }) => ({
      occurrenceId,
      sourceEvidence: makeSourceEvidence(commercialTotal, 'COMMERCIAL_CONTEXT', 'commerce.catalog', validatedAt),
    })),
    decision: commercialTotal.decision,
    market: makeSourceEvidence(commercialTotal, 'COMMERCIAL_CONTEXT', 'commerce.market-catalog', validatedAt),
    priceGroupAssignment: makeSourceEvidence(
      commercialTotal,
      'COMMERCIAL_CONTEXT',
      'commerce.customer-context',
      validatedAt,
    ),
    promotion: {
      kind: 'PROMOTION_SELECTED',
      sourceEvidence: makeSourceEvidence(commercialTotal, 'PROMOTION', 'commerce.promotion', validatedAt),
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
      currencySupport: makeSourceEvidence(commercialTotal, 'CURRENCY_SUPPORT', pricingOwnerModuleId, validatedAt),
      externalOwnerEvidence,
      lines: commercialTotal.decision.lines.map(({ occurrenceId }) => ({
        commercialFees: makeSourceEvidence(commercialTotal, 'COMMERCIAL_FEE', pricingOwnerModuleId, validatedAt),
        lineDiscounts: {
          kind: 'DISCOUNT_SELECTED' as const,
          sourceEvidence: makeSourceEvidence(commercialTotal, 'DISCOUNT', pricingOwnerModuleId, validatedAt),
        },
        occurrenceId,
        pricePath: { usedPrice: makeSourceEvidence(commercialTotal, 'PRICE', pricingOwnerModuleId, validatedAt) },
        quantityTiers: makeSourceEvidence(commercialTotal, 'QUANTITY_TIER', pricingOwnerModuleId, validatedAt),
      })),
      requestedAt,
      revalidatedAt: validatedAt,
      wholePurchase: {
        contractualDiscounts: {
          kind: 'DISCOUNT_SELECTED',
          sourceEvidence: makeSourceEvidence(commercialTotal, 'DISCOUNT', pricingOwnerModuleId, validatedAt),
        },
      },
    },
    validatedAt,
  };
};

export const makeIssue788Attempt = (
  commercialTotal: Issue788CommercialTotal,
  materialEvidence: PricingMaterialEvidenceReady,
): PricingEvaluationAttempt => {
  const attemptId = 'pricing-evaluation-attempt:788:a';
  const evidence = materialEvidence.sourceEvidence;
  const materialBindings: PricingMaterialStateSnapshot['materialBindings'] = [
    ...evidence.externalOwnerEvidence.catalogSelections.map(({ sourceEvidence }, index) => ({
      bindingRef: `pricing-material-binding:catalog:${index}:788`,
      kind: 'CATALOG_SELECTION' as const,
      meaningRef: `pricing-material-meaning:catalog:${index}:788`,
      sourceEvidence,
    })),
    {
      bindingRef: 'pricing-material-binding:market:788',
      kind: 'COMMERCIAL_SCOPE',
      meaningRef: 'pricing-material-meaning:market:788',
      sourceEvidence: evidence.externalOwnerEvidence.market,
    },
    ...(evidence.externalOwnerEvidence.priceGroupAssignment === undefined
      ? []
      : [
          {
            bindingRef: 'pricing-material-binding:price-group:788',
            kind: 'AUDIENCE_OR_GROUP' as const,
            meaningRef: 'pricing-material-meaning:price-group:788',
            sourceEvidence: evidence.externalOwnerEvidence.priceGroupAssignment,
          },
        ]),
    ...(evidence.externalOwnerEvidence.promotion.kind === 'PROMOTION_SELECTED'
      ? [
          {
            bindingRef: 'pricing-material-binding:promotion:788',
            kind: 'PROMOTION_OR_ALLOCATION' as const,
            meaningRef: 'pricing-material-meaning:promotion:788',
            sourceEvidence: evidence.externalOwnerEvidence.promotion.sourceEvidence,
          },
        ]
      : []),
    {
      bindingRef: 'pricing-material-binding:currency-support:788',
      kind: 'CURRENCY_SUPPORT',
      meaningRef: 'pricing-material-meaning:currency-support:788',
      sourceEvidence: evidence.currencySupport,
    },
    ...evidence.lines.flatMap(
      ({ commercialFees, lineDiscounts, occurrenceId, pricePath, quantityTiers, zeroFloor }) => [
        {
          bindingRef: `pricing-material-binding:price:${occurrenceId}:788`,
          kind: 'EXACT_PRICE_SET' as const,
          meaningRef: `pricing-material-meaning:price:${occurrenceId}:788`,
          sourceEvidence: pricePath.usedPrice,
        },
        ...(pricePath.assignedGroupAbsence === undefined
          ? []
          : [
              {
                bindingRef: `pricing-material-binding:group-absence:${occurrenceId}:788`,
                kind: 'EXACT_PRICE_SET' as const,
                meaningRef: `pricing-material-meaning:group-absence:${occurrenceId}:788`,
                sourceEvidence: pricePath.assignedGroupAbsence,
              },
            ]),
        {
          bindingRef: `pricing-material-binding:tier:${occurrenceId}:788`,
          kind: 'QUANTITY_TIER_SET' as const,
          meaningRef: `pricing-material-meaning:tier:${occurrenceId}:788`,
          sourceEvidence: quantityTiers,
        },
        ...(lineDiscounts.kind === 'DISCOUNT_SELECTED'
          ? [
              {
                bindingRef: `pricing-material-binding:line-discount:${occurrenceId}:788`,
                kind: 'DISCOUNT_SET' as const,
                meaningRef: `pricing-material-meaning:line-discount:${occurrenceId}:788`,
                sourceEvidence: lineDiscounts.sourceEvidence,
              },
            ]
          : []),
        {
          bindingRef: `pricing-material-binding:fee:${occurrenceId}:788`,
          kind: 'COMMERCIAL_FEE_SET' as const,
          meaningRef: `pricing-material-meaning:fee:${occurrenceId}:788`,
          sourceEvidence: commercialFees,
        },
        ...(zeroFloor === undefined
          ? []
          : [
              {
                bindingRef: `pricing-material-binding:zero-floor:${occurrenceId}:788`,
                kind: 'ZERO_FLOOR_SCOPE_OR_COVERAGE' as const,
                meaningRef: `pricing-material-meaning:zero-floor:${occurrenceId}:788`,
                sourceEvidence: zeroFloor,
              },
            ]),
      ],
    ),
    ...(evidence.wholePurchase.contractualDiscounts.kind === 'DISCOUNT_SELECTED'
      ? [
          {
            bindingRef: 'pricing-material-binding:whole-discount:788',
            kind: 'WHOLE_PURCHASE_BASIS_OR_ALLOCATION' as const,
            meaningRef: 'pricing-material-meaning:whole-discount:788',
            sourceEvidence: evidence.wholePurchase.contractualDiscounts.sourceEvidence,
          },
        ]
      : []),
  ];
  return {
    attemptId,
    attemptOrdinal: 1,
    candidateRef: commercialTotal.candidateRef,
    completedAt: issue788IssuedAt,
    maxAttempts: 2,
    runId: 'pricing-evaluation-run:788:a',
    snapshot: {
      attemptId,
      calculationVersions: materialEvidence.calculationVersions,
      candidateRef: commercialTotal.candidateRef,
      capturedAt: materialEvidence.validatedAt,
      decision: commercialTotal.decision,
      materialBindings,
      requestedAt: commercialTotal.decision.operationTime,
      snapshotId: 'pricing-material-snapshot:788:a',
    },
    startedAt: commercialTotal.decision.operationTime,
  };
};

export const makeIssue788CurrentSource = (
  commercialTotal: Issue788CommercialTotal,
): PricingCurrentBackedConfirmationSource => {
  const materialEvidence = makeIssue788MaterialEvidence(commercialTotal);
  const attempt = makeIssue788Attempt(commercialTotal, materialEvidence);
  return {
    currentness: { _tag: 'FRESH', attempt, retryDirective: 'NONE' },
    currentResult: { commercialTotal, kind: 'CURRENT_PRICING_RESULT' },
    kind: 'CURRENT_BACKED',
    materialEvidence,
  };
};

export const makeIssue788Quotation = (
  commercialTotal: Issue788CommercialTotal,
  quotationRef = 'pricing-quotation:788:900',
  validUntil = issue788QuoteValidUntil,
): PricingQuotationIssued =>
  decodeQuotation({
    binding: makeIssue788PurchaseBinding(commercialTotal),
    issuedAt: issue788IssuedAt,
    kind: 'PRICING_QUOTATION',
    materialEvidence: makeIssue788MaterialEvidence(commercialTotal, issue788IssuedAt),
    quotationRef,
    quotedResult: commercialTotal,
    validity: decodeQuotationValidity({
      policyEvidence: {
        maximumValidityDurationMilliseconds: 600_000,
        policyRef: 'pricing-quotation-validity:launch',
        policyVersion: '2026-09-28',
      },
      validFrom: '2026-09-28T11:55:00.000Z',
      validUntil,
    }),
  });

export const makeIssue788QuotationAuthenticity = (
  quotation: PricingQuotationIssued,
): PricingQuotationAuthenticityVerificationEvidence => ({
  authenticityRef: `pricing-quotation-authenticity:${quotation.quotationRef}`,
  authority: 'EVIDENCE_ONLY',
  issuerRef: 'pricing-quotation-owner:launch',
  keyRef: 'pricing-quotation-key:launch',
  keyStatus: 'ACTIVE',
  keyVersion: '3',
  lineageRef: 'pricing-quotation-key-lineage:launch',
  payloadDigest: `sha256:${quotation.quotationRef}`,
  proofVersion: '1',
  quotationRef: quotation.quotationRef,
  verifiedAt: issue788IssuedAt,
});

export const makeIssue788QuotationSource = (
  quotation: PricingQuotationIssued,
  materialEvidence = quotation.materialEvidence,
): PricingQuotationBackedConfirmationSource => {
  const quotationRevalidation: PricingQuotationExactReuse = {
    authenticityEvidence: makeIssue788QuotationAuthenticity(quotation),
    bindingProof: { kind: 'DIRECT_EXACT_MATCH' },
    evaluatedAt: issue788IssuedAt,
    kind: 'EXACT_REUSE',
    quotation,
    termsAuthority: 'ORIGINAL_QUOTATION',
  };
  return { kind: 'QUOTATION_BACKED', materialEvidence, quotationRevalidation };
};

export const issue788ConfirmationAuthenticity: PricingCommitmentConfirmationAuthenticityProof = {
  authority: 'EVIDENCE_ONLY',
  issuerRef: 'pricing-confirmation-owner:launch',
  keyRef: 'pricing-confirmation-key:launch',
  keyVersion: '1',
  lineageRef: 'pricing-confirmation-key-lineage:launch',
  payloadDigest: 'sha256:pricing-confirmation:788:a',
  proofRef: 'pricing-confirmation-proof:788:a',
  proofVersion: '1',
};

export const makeIssue788IssuedConfirmation = (
  commercialTotal: Issue788CommercialTotal,
  options?: {
    readonly confirmationRef?: string;
    readonly expiresAt?: string;
    readonly issuedAt?: string;
    readonly materialEvidence?: PricingMaterialEvidenceReady;
    readonly quotation?: PricingQuotationIssued;
  },
): PricingCommitmentConfirmationIssued => {
  const quotation = options?.quotation ?? makeIssue788Quotation(commercialTotal);
  return Schema.decodeSync(PricingCommitmentConfirmationIssuedSchema, {
    onExcessProperty: 'error',
  })({
    authenticity: issue788ConfirmationAuthenticity,
    binding: makeIssue788Binding(commercialTotal),
    confirmationRef: options?.confirmationRef ?? 'pricing-confirmation:788:a',
    expiresAt: options?.expiresAt ?? issue788ExpiresAt,
    issuedAt: options?.issuedAt ?? issue788IssuedAt,
    kind: 'PRICING_COMMITMENT_CONFIRMATION',
    source: makeIssue788QuotationSource(quotation, options?.materialEvidence),
    terms: quotation.quotedResult,
  });
};

export const makeIssue788CurrentConfirmation = (
  commercialTotal: Issue788CommercialTotal,
  options?: {
    readonly confirmationRef?: string;
    readonly expiresAt?: string;
    readonly issuedAt?: string;
  },
): PricingCommitmentConfirmationIssued =>
  Schema.decodeSync(PricingCommitmentConfirmationIssuedSchema, {
    onExcessProperty: 'error',
  })({
    authenticity: issue788ConfirmationAuthenticity,
    binding: makeIssue788Binding(commercialTotal),
    confirmationRef: options?.confirmationRef ?? 'pricing-confirmation:788:current:a',
    expiresAt: options?.expiresAt ?? issue788ExpiresAt,
    issuedAt: options?.issuedAt ?? issue788IssuedAt,
    kind: 'PRICING_COMMITMENT_CONFIRMATION',
    source: makeIssue788CurrentSource(commercialTotal),
    terms: commercialTotal,
  });
