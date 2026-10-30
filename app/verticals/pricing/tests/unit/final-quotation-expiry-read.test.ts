import { PRICING_CZK_PUBLICATION_PROFILE_VERSION } from '@app/pricing-contracts/domain/exact-decimal';
import { PricingQuotationBindingSchema, PricingQuotationIssuedSchema } from '@app/pricing-contracts/domain/quotation';
import { QuotationVerificationResponseSchema } from '@app/pricing-contracts/quotation-verification';
import { DateTime, Effect, Schema } from 'effect';
import { describe, expect, it } from 'effect-rstest';

import { finalQuotationStatus } from '../../src/api/quotation-verification.read.ts';
import { calculatePricingCommercialTotals } from '../../src/services/commercial-totals.service.ts';
import { publishPricingLineValues } from '../../src/services/line-value-publication.service.ts';
import {
  candidateRef,
  makeIssue779PreRoundScenario,
  requireIssue779ProductUnitRef,
} from './support/issue-779-line-value.fixture.ts';
import { makeQuotationMaterialEvidence } from './support/quotation-material-evidence.fixture.ts';

const validFrom = '2026-10-29T11:00:00.000Z';
const validUntil = '2026-10-29T12:00:00.000Z';

const issuedQuotation = Effect.gen(function* finalQuotationFixture() {
  const { preRound } = yield* makeIssue779PreRoundScenario({ discounts: ['0', '0', '0'], priceAmount: '100' });
  const publication = yield* publishPricingLineValues({
    candidateRef,
    decision: preRound.decision,
    preRound,
    publicationProfileVersion: PRICING_CZK_PUBLICATION_PROFILE_VERSION,
  });
  if (publication.outcome !== 'LINE_VALUES_PUBLISHED') {
    return yield* Effect.die(`Final Quotation fixture expected publication: ${publication.failure.code}`);
  }
  const total = yield* calculatePricingCommercialTotals({
    candidateRef,
    decision: preRound.decision,
    preRound,
    publishedLines: publication.publishedLines,
  });
  if (total.outcome !== 'COMMERCIAL_TOTAL_READY') {
    return yield* Effect.die(`Final Quotation fixture expected a commercial total: ${total.failure.code}`);
  }
  const binding = yield* Schema.decodeEffect(PricingQuotationBindingSchema)({
    candidateRef,
    commercialScope: total.decision.commercialScope,
    currencyCode: total.decision.currencyCode,
    lines: total.decision.lines.map(({ catalog, occurrenceId }) => ({
      occurrenceId,
      quantity: { amount: catalog.quantity.resulting, unitRef: requireIssue779ProductUnitRef(catalog.unitRef) },
      selection: catalog.selection,
    })),
    monetaryBoundary: total.decision.monetaryBoundary,
    subject: {
      guestEvidenceRef: 'guest-evidence:final',
      guestSessionRef: 'guest-session:final',
      kind: 'GUEST',
      purchaseContext: {
        contextRef: total.decision.purchasingContext.contextRef,
        contextRevision: total.decision.purchasingContext.contextRevision,
      },
    },
    tenantId: total.decision.tenantId,
  });
  return yield* Schema.decodeEffect(PricingQuotationIssuedSchema)({
    binding,
    issuedAt: validFrom,
    kind: 'PRICING_QUOTATION',
    materialEvidence: makeQuotationMaterialEvidence(total),
    quotationRef: 'pricing-quotation:final',
    quotedResult: total,
    validity: {
      policyEvidence: { maximumValidityDurationMilliseconds: 3_600_000, policyRef: 'policy', policyVersion: '1' },
      validFrom,
      validUntil,
    },
  });
});

const expiryEvaluations = { afterEnd: '2026-10-29T12:00:01.000Z', beforeEnd: '2026-10-29T11:59:59.999Z' } as const;
const expiredResponse = (
  evaluation: keyof typeof expiryEvaluations = 'afterEnd',
  evidenceRef = 'pricing-quotation:final',
) => {
  const evaluatedAt = expiryEvaluations[evaluation];
  return {
    authenticityEvidence: {
      authenticityRef: 'pricing:quotation-proof:final',
      authority: 'EVIDENCE_ONLY',
      issuerRef: 'commerce.pricing',
      keyRef: 'pricing-key',
      keyStatus: 'ACTIVE',
      keyVersion: '1',
      lineageRef: 'pricing-lineage',
      payloadDigest: 'c'.repeat(64),
      proofVersion: '1',
      quotationRef: evidenceRef,
      verifiedAt: evaluatedAt,
    },
    expired: {
      _tag: 'EXPIRED',
      evaluatedAt,
      quotationRef: 'pricing-quotation:final',
      validity: {
        policyEvidence: { maximumValidityDurationMilliseconds: 3_600_000, policyRef: 'policy', policyVersion: '1' },
        validFrom,
        validUntil,
      },
    },
    outcome: 'QUOTATION_EXPIRED',
  };
};

describe('Pricing final Quotation verification expiry', () => {
  it.effect('reports expiry only for the exact final candidate at or after its exclusive end', () =>
    Effect.gen(function* classifyFinalQuotation() {
      const quotation = yield* issuedQuotation;
      const candidate = {
        candidateRef: { resourceId: candidateRef },
        pricing: { decision: quotation.quotedResult.decision },
        tenantId: quotation.binding.tenantId,
      };
      expect(finalQuotationStatus(quotation, candidate, '2026-10-29T11:59:59.999Z')).toBe('VALID');
      // Cart freezes its commitment time before its per-entry Catalog requests; Pricing quotes at its own later
      // instant, so an earlier retained operation time is the same final meaning.
      const frozenBeforeCatalog = {
        ...candidate,
        pricing: {
          decision: {
            ...quotation.quotedResult.decision,
            operationTime: DateTime.formatIso(
              DateTime.subtract(DateTime.makeUnsafe(quotation.quotedResult.decision.operationTime), { minutes: 1 }),
            ),
          },
        },
      };
      expect(finalQuotationStatus(quotation, frozenBeforeCatalog, '2026-10-29T11:59:59.999Z')).toBe('VALID');
      expect(finalQuotationStatus(quotation, candidate, validUntil)).toBe('EXPIRED');
      expect(finalQuotationStatus(quotation, candidate, '2026-10-29T10:59:59.999Z')).toBe('NOT_YET_VALID');
      // An expired Quotation for another candidate or tenant stays a retryable mismatch, never terminal.
      expect(
        finalQuotationStatus(
          quotation,
          { ...candidate, candidateRef: { resourceId: 'another-candidate' } },
          validUntil,
        ),
      ).toBe('MISMATCHED');
      expect(
        finalQuotationStatus(quotation, { ...candidate, tenantId: '99999999-9999-4999-8999-999999999999' }, validUntil),
      ).toBe('MISMATCHED');
    }),
  );
  it.effect('publishes expiry as a typed outcome bound to the authenticated exact Quotation', () =>
    Effect.gen(function* typedExpiryContract() {
      const decoded = yield* Schema.decodeUnknownEffect(QuotationVerificationResponseSchema)(expiredResponse());
      expect(decoded.outcome).toBe('QUOTATION_EXPIRED');
      for (const forged of [expiredResponse('afterEnd', 'pricing-quotation:other'), expiredResponse('beforeEnd')]) {
        expect(Schema.is(QuotationVerificationResponseSchema)(forged)).toBe(false);
      }
    }),
  );
});
