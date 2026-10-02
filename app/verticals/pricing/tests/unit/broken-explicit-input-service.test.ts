import {
  PricingExplicitInputContextSchema,
  PricingExplicitInputEvaluationRequestSchema,
  PricingExplicitInputIndeterminateSchema,
  PricingKnownInvalidExplicitInputSchema,
  PricingNonCanonicalAssertionHeldSchema,
} from '@app/pricing-contracts/domain/broken-explicit-input';
import { PriceIdentityKeySchema } from '@app/pricing-contracts/domain/price-definition';
import { DateTime, Effect, Schema } from 'effect';
import { describe, expect, it } from 'effect-rstest';

import {
  evaluatePricingExplicitInput,
  makeBrokenExplicitInputValidationService,
} from '../../src/services/broken-explicit-input.service.ts';

const tenantId = '11111111-1111-4111-8111-111111111111';
const legalEntityId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const effectiveAt = '2026-09-27T12:00:00.000Z';
const catalogRef = (resourceId: string, resourceType: string) => ({
  moduleId: 'commerce.catalog' as const,
  resourceId,
  resourceType,
  tenantId,
});
const productRef = catalogRef('22222222-2222-4222-8222-222222222222', 'commerce.catalog.product');
const variantRef = catalogRef('33333333-3333-4333-8333-333333333333', 'commerce.catalog.variant');
const unitRef = catalogRef('44444444-4444-4444-8444-444444444444', 'commerce.catalog.product-unit');
const priceGroupRef = {
  moduleId: 'pricing.price-group-catalog',
  resourceId: '55555555-5555-4555-8555-555555555555',
  resourceType: 'pricing.price-group-catalog.price-group',
  tenantId,
} as const;
const exactKey = Schema.decodeUnknownSync(PriceIdentityKeySchema, { onExcessProperty: 'error' })({
  catalogSelection: { productRef, variantRef },
  commercialScope: { channelId: 'B2C', marketId: 'cz-launch', sellingLegalEntityId: legalEntityId },
  currencyCode: 'CZK',
  priceGroupSelector: { kind: 'NO_GROUP' as const },
  unitBasis: { quantity: '1', unitRef },
});
const context = Schema.decodeSync(PricingExplicitInputContextSchema, { onExcessProperty: 'error' })({
  effectiveAt,
  exactKey,
  requestedCurrencyCode: 'CZK',
  tenantId,
});
const decodeRequest = Schema.decodeUnknownSync(PricingExplicitInputEvaluationRequestSchema, {
  onExcessProperty: 'error',
});

describe('Issue #765 broken explicit input runtime', () => {
  it('treats missing owner observations as indeterminate, never as absence', () => {
    const result = evaluatePricingExplicitInput(decodeRequest({ context }));

    expect(Schema.is(PricingExplicitInputIndeterminateSchema)(result)).toBe(true);
    expect(result).toMatchObject({
      outcome: 'PRICING_INDETERMINATE',
      reason: 'CURRENCY_SUPPORT_UNVERIFIABLE',
      subject: 'CURRENCY_SUPPORT',
    });
  });

  it('preserves a broken assignment as a non-retryable configuration outcome without lookup or fallback', () => {
    const result = evaluatePricingExplicitInput(
      decodeRequest({
        context,
        priceGroupResolutionInput: {
          _tag: 'BLOCKED',
          effectiveAt,
          interpretation: {
            _tag: 'BROKEN',
            assignmentResolution: {
              _tag: 'BROKEN',
              assignmentRef: {
                moduleId: 'commerce.customer-context',
                resourceId: '66666666-6666-4666-8666-666666666666',
                resourceType: 'commerce.customer-context.customer-price-group-assignment',
                tenantId,
              },
              assignmentRevision: 4,
              catalogRevision: null,
              priceGroupRef,
              reason: 'MISSING',
            },
            basis: {
              catalogSelection: exactKey.catalogSelection,
              commercialScope: exactKey.commercialScope,
              currencyCode: 'CZK',
              unitBasis: exactKey.unitBasis,
            },
            reason: 'MISSING',
            source: 'COMMERCE_ASSIGNMENT',
          },
        },
      }),
    );

    expect(Schema.is(PricingKnownInvalidExplicitInputSchema)(result)).toBe(true);
    expect(result).toMatchObject({
      outcome: 'PRICING_CONFIGURATION_ERROR',
      reason: 'BROKEN_PRICE_GROUP_ASSIGNMENT',
      retryable: false,
    });
    expect(result).not.toHaveProperty('continuation');
    expect(result).not.toHaveProperty('exactResolutionInput');
  });

  it('holds gross-only source evidence without reverse-Tax or canonical promotion', () => {
    const result = evaluatePricingExplicitInput(
      decodeRequest({
        context,
        sourceAssessment: {
          outcome: 'PRICE_SOURCE_ASSERTION_UNRESOLVED_HELD',
          reason: 'AUTHORITATIVE_PRE_TAX_NORMALIZATION_MISSING',
          sourceAssertionId: '77777777-7777-4777-8777-777777777777',
        },
      }),
    );

    expect(Schema.is(PricingNonCanonicalAssertionHeldSchema)(result)).toBe(true);
    expect(result).toMatchObject({
      outcome: 'PRICING_INDETERMINATE',
      reason: 'AUTHORITATIVE_PRE_TAX_NORMALIZATION_MISSING',
    });
    expect(result).not.toHaveProperty('normalizedPreTaxAmount');
    expect(result).not.toHaveProperty('exactResolutionInput');
  });

  it.effect('rejects trusted scope mismatch before acquiring any owner observation', () =>
    Effect.gen(function* trustedMismatch() {
      let acquisitions = 0;
      const service = makeBrokenExplicitInputValidationService({
        acquire: () => {
          acquisitions += 1;
          return Effect.die('must not acquire outside trusted scope');
        },
      });
      const result = yield* service.evaluate(context, {
        legalEntityId,
        tenantId: '99999999-9999-4999-8999-999999999999',
        trustedOperationAt: DateTime.makeUnsafe(effectiveAt),
      });

      expect(acquisitions).toBe(0);
      expect(Schema.is(PricingKnownInvalidExplicitInputSchema)(result)).toBe(true);
      expect(result).toMatchObject({
        outcome: 'PRICING_CONFIGURATION_ERROR',
        reason: 'INVALID_CANONICAL_CONFIGURATION',
      });
    }),
  );
});
