import { Schema } from 'effect';
import { describe, expect, it } from 'effect-rstest';

import {
  PricingQuotationAuthorityBindingSchema,
  PricingQuotationBindingSchema,
  PricingCommercialAuthorityResultSchema,
  PricingCommitmentConfirmationReferenceSchema,
  PricingQuotationIssuanceRequestSchema,
  PricingRetainedDisplayOnlyResultSchema,
} from '../../src/domain/quotation.ts';

const tenantId = '11111111-1111-4111-8111-111111111111';
const unitRef = {
  moduleId: 'commerce.catalog',
  resourceId: '22222222-2222-4222-8222-222222222222',
  resourceType: 'commerce.catalog.product-unit',
  tenantId,
} as const;
const selection = {
  productRef: {
    moduleId: 'commerce.catalog',
    resourceId: '33333333-3333-4333-8333-333333333333',
    resourceType: 'commerce.catalog.product',
    tenantId,
  },
  variantRef: {
    moduleId: 'commerce.catalog',
    resourceId: '44444444-4444-4444-8444-444444444444',
    resourceType: 'commerce.catalog.variant',
    tenantId,
  },
} as const;
const guestSubject = {
  guestEvidenceRef: 'customer-context:guest-evidence:1',
  guestSessionRef: 'cart:guest-session:1',
  kind: 'GUEST',
  purchaseContext: { contextRef: 'purchase-context:1', contextRevision: 'revision:1' },
} as const;
const quotationBinding = {
  candidateRef: 'purchase-candidate-1',
  commercialScope: {
    channelId: 'B2C',
    marketId: 'market-cz-b2c',
    sellingLegalEntityId: '55555555-5555-4555-8555-555555555555',
  },
  currencyCode: 'CZK',
  lines: [
    {
      occurrenceId: 'purchase-occurrence-1',
      quantity: { amount: '100', unitRef },
      selection,
    },
  ],
  monetaryBoundary: 'PRE_TAX',
  subject: guestSubject,
  tenantId,
} as const;

const display = {
  candidateRef: 'purchase-candidate-1',
  currencyCode: 'CZK',
  lines: [
    {
      occurrenceId: 'purchase-occurrence-1',
      publishedLineValue: { amount: '900', currencyCode: 'CZK' },
    },
  ],
  monetaryBoundary: 'PRE_TAX',
  pricingNetCommercialTotal: { amount: '900', currencyCode: 'CZK' },
} as const;

const retained = {
  display,
  guarantee: 'NONE',
  kind: 'RETAINED_DISPLAY_ONLY',
  retainedAt: '2026-09-28T10:00:00.000Z',
} as const;

describe('Pricing Current result versus Quotation contract', () => {
  it('binds one exact candidate, explicit Variant, resulting Quantity+Unit, scope, currency, and Guest authority', () => {
    expect(Schema.decodeSync(PricingQuotationBindingSchema)(quotationBinding)).toEqual(quotationBinding);
  });

  it('preserves occurrence identity and cardinality instead of treating equal quantities as the same purchase', () => {
    expect(
      Schema.is(PricingQuotationBindingSchema)({
        ...quotationBinding,
        lines: [...quotationBinding.lines, quotationBinding.lines[0]],
      }),
    ).toBe(false);
    expect(
      Schema.is(PricingQuotationBindingSchema)({
        ...quotationBinding,
        lines: [{ ...quotationBinding.lines[0], quantity: { amount: '101', unitRef } }],
      }),
    ).toBe(true);
  });

  it('requires exactly one authenticated-or-Guest authority and never accepts Product-only selection', () => {
    expect(
      Schema.is(PricingQuotationBindingSchema)({
        ...quotationBinding,
        lines: [{ ...quotationBinding.lines[0], selection: { productRef: selection.productRef } }],
      }),
    ).toBe(false);
    expect(
      Schema.is(PricingQuotationAuthorityBindingSchema)({
        ...guestSubject,
        kind: 'AUTHENTICATED',
        subjectEvidenceRef: 'authentication:evidence:1',
        subjectRef: {
          moduleId: 'party.registry',
          resourceId: 'subject:1',
          resourceType: 'party.registry.party',
          tenantId,
        },
      }),
    ).toBe(false);
  });

  it('keeps Storefront and Tax outside strict quotation monetary identity', () => {
    const decodeStrict = Schema.decodeUnknownSync(PricingQuotationBindingSchema, { onExcessProperty: 'error' });
    expect(() => decodeStrict({ ...quotationBinding, storefrontId: 'storefront-a' })).toThrow();
    expect(() => decodeStrict({ ...quotationBinding, taxTotal: { amount: '189', currencyCode: 'CZK' } })).toThrow();
  });

  it('marks a retained result as display-only with no guarantee authority', () => {
    expect(Schema.decodeSync(PricingRetainedDisplayOnlyResultSchema)(retained)).toEqual(retained);
    expect(Schema.is(PricingCommercialAuthorityResultSchema)(retained)).toBe(true);
  });

  it('never accepts retained display state at the explicit quotation-issuance boundary', () => {
    expect(
      Schema.is(PricingQuotationIssuanceRequestSchema)({
        currentResult: retained,
        issuedAt: '2026-09-28T10:00:00.000Z',
        kind: 'ISSUE_PRICING_QUOTATION',
        validity: {
          validFrom: '2026-09-28T10:00:00.000Z',
          validUntil: '2026-09-28T10:15:00.000Z',
        },
      }),
    ).toBe(false);
  });

  it('keeps a Commitment Confirmation as an opaque reference to the separate #788 proof contract', () => {
    const confirmation = {
      confirmationRef: 'pricing-confirmation-1',
      kind: 'PRICING_COMMITMENT_CONFIRMATION_REFERENCE',
    } as const;

    expect(Schema.decodeSync(PricingCommitmentConfirmationReferenceSchema)(confirmation)).toEqual(confirmation);
    expect(Schema.is(PricingCommercialAuthorityResultSchema)(confirmation)).toBe(true);
    expect(() =>
      Schema.decodeUnknownSync(PricingCommitmentConfirmationReferenceSchema, { onExcessProperty: 'error' })({
        ...confirmation,
        expiresAt: '2026-09-28T10:00:30.000Z',
        quotationRef: 'pricing-quotation-1',
      }),
    ).toThrow();
  });

  it('does not let support arrays, currency selection, Tax, or final-payable fields mint a guarantee', () => {
    const decodeStrict = Schema.decodeUnknownSync(PricingRetainedDisplayOnlyResultSchema, {
      onExcessProperty: 'error',
    });

    for (const forbidden of ['supportedCurrencies', 'selectedCurrency', 'taxTotal', 'finalPayable', 'quotationRef']) {
      expect(() => decodeStrict({ ...retained, [forbidden]: forbidden === 'selectedCurrency' ? 'EUR' : [] })).toThrow();
    }
  });
});
