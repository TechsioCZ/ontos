import { Schema } from 'effect';
import { describe, expect, it } from 'effect-rstest';

import {
  PricingAcceptedCurrentLineageSchema,
  PricingAcceptedLegacyCurrencySupportReferenceSchema,
  PricingAcceptedQuotationLineageSchema,
} from '../../src/domain/accepted-order-handoff.ts';

const tenantId = '11111111-1111-4111-8111-111111111111';
const ownerScope = {
  ownerModuleId: 'legacy.pricing',
  ownerRootRef: 'legacy-currency-support:partition-a',
  predicateRef: 'legacy-currency-support:tenant-a',
  tenantId,
} as const;

const confirmationBinding = {
  attemptRef: 'order-commitment-attempt:789',
  confirmationRef: 'pricing-confirmation:789',
  decisionBundleHash: 'sha256:bundle-789',
  decisionBundleRef: 'order-decision-bundle:789',
  decisionBundleVersion: '1',
} as const;

describe('Pricing Accepted order handoff contract', () => {
  it('distinguishes exact Current and Quotation-to-Confirmation lineage', () => {
    const current = {
      ...confirmationBinding,
      kind: 'CURRENT_TO_CONFIRMATION',
      materialEvidenceValidatedAt: '2026-09-28T12:00:00.000Z',
    } as const;
    const quotation = {
      ...confirmationBinding,
      kind: 'QUOTATION_TO_CONFIRMATION',
      quotationIssuedAt: '2026-09-28T11:55:00.000Z',
      quotationRef: 'pricing-quotation:789',
      quotationRevalidatedAt: '2026-09-28T12:00:00.000Z',
    } as const;

    expect(Schema.decodeSync(PricingAcceptedCurrentLineageSchema)(current)).toEqual(current);
    expect(Schema.decodeSync(PricingAcceptedQuotationLineageSchema)(quotation)).toEqual(quotation);
    expect(Schema.is(PricingAcceptedCurrentLineageSchema)(quotation)).toBe(false);
    expect(Schema.is(PricingAcceptedQuotationLineageSchema)(current)).toBe(false);
  });

  it('retains generalized historical Currency Support under an owner-qualified original identity', () => {
    const historical = {
      effectivePeriod: {
        effectiveFrom: '2025-01-01T00:00:00.000Z',
        effectiveTo: '2026-01-01T00:00:00.000Z',
      },
      generation: 1,
      ownerScope,
      supportedCurrencies: ['CZK', 'EUR'],
      supportRevisionRef: 'pricing-currency-support:1',
      verificationRef: 'legacy-support-proof:partition-a:1',
    } as const;

    expect(Schema.decodeSync(PricingAcceptedLegacyCurrencySupportReferenceSchema)(historical)).toEqual(historical);
  });

  it('keeps corrective migration lineage additive and rejects a no-op replacement', () => {
    const base = {
      effectivePeriod: { effectiveFrom: '2025-01-01T00:00:00.000Z', effectiveTo: null },
      generation: 1,
      ownerScope,
      supportedCurrencies: ['EUR'],
      supportRevisionRef: 'pricing-currency-support:1',
      verificationRef: 'legacy-support-proof:partition-a:1',
    } as const;
    const migration = {
      auditRef: 'migration-audit:789',
      migratedAt: '2026-09-28T12:00:00.000Z',
      migrationRef: 'corrective-migration:789',
      successorOwnerScope: { ...ownerScope, ownerRootRef: 'pricing-currency-support:partition-a' },
      successorSupportRevisionRef: 'pricing-currency-support-revision:successor-1',
    } as const;

    expect(
      Schema.is(PricingAcceptedLegacyCurrencySupportReferenceSchema)({
        ...base,
        correctiveMigrationLineage: migration,
      }),
    ).toBe(true);
    expect(
      Schema.is(PricingAcceptedLegacyCurrencySupportReferenceSchema)({
        ...base,
        correctiveMigrationLineage: {
          ...migration,
          successorOwnerScope: ownerScope,
          successorSupportRevisionRef: base.supportRevisionRef,
        },
      }),
    ).toBe(false);
  });

  it('does not admit tax, shipping, delivery, final-payable, or Order workflow fields into lineage', () => {
    const decodeStrict = Schema.decodeUnknownSync(PricingAcceptedCurrentLineageSchema, {
      onExcessProperty: 'error',
    });
    const current = {
      ...confirmationBinding,
      kind: 'CURRENT_TO_CONFIRMATION',
      materialEvidenceValidatedAt: '2026-09-28T12:00:00.000Z',
    } as const;

    for (const forbidden of ['delivery', 'finalPayable', 'orderStatus', 'shipping', 'tax']) {
      expect(() => decodeStrict({ ...current, [forbidden]: 'not-pricing-truth' })).toThrow();
    }
  });
});
