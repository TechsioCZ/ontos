import type { ExactPriceLookupRequest, ExactPriceLookupResult } from '@app/pricing-contracts/domain/exact-price-lookup';
import {
  ExactPriceLookupAbsentSchema,
  ExactPriceLookupFoundSchema,
  ExactPriceLookupUnverifiableSchema,
} from '@app/pricing-contracts/domain/exact-price-lookup';
import {
  ExactPriceConfigurationErrorResolutionSchema,
  ExactPriceFoundResolutionSchema,
  ExactPriceIndeterminateResolutionSchema,
  ExactPriceResolutionInputSchema,
} from '@app/pricing-contracts/domain/exact-price-resolution';
import { DateTime, Effect, Match, Schema } from 'effect';
import { describe, expect, it } from 'effect-rstest';

import { makeExactPriceResolutionService } from '../../src/services/exact-price-resolution.service.ts';

const tenantId = '11111111-1111-4111-8111-111111111111';
const legalEntityId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const effectiveAt = '2026-09-27T12:00:00.000Z';
const observedAt = '2026-09-27T12:00:00.050Z';
const supportRootId = '12121212-1212-4212-8212-121212121212';
const supportRevisionId = '13131313-1313-4313-8313-131313131313';

const catalogRef = (resourceId: string, resourceType: string) => ({
  moduleId: 'commerce.catalog' as const,
  resourceId,
  resourceType,
  tenantId,
});
const priceGroupRef = {
  moduleId: 'pricing.price-group-catalog',
  resourceId: '77777777-7777-4777-8777-777777777777',
  resourceType: 'pricing.price-group-catalog.price-group',
  tenantId,
} as const;
const selection = {
  packageOption: {
    contentRevision: {
      resourceRef: catalogRef('99999999-9999-4999-8999-999999999999', 'commerce.catalog.package-definition'),
      revision: 5,
    },
    optionRef: catalogRef('99999999-9999-4999-8999-999999999999', 'commerce.catalog.package-definition'),
  },
  productRef: catalogRef('22222222-2222-4222-8222-222222222222', 'commerce.catalog.product'),
  variantRef: catalogRef('33333333-3333-4333-8333-333333333333', 'commerce.catalog.variant'),
} as const;
const basis = {
  catalogSelection: selection,
  commercialScope: { channelId: 'B2C', marketId: 'CZ', sellingLegalEntityId: legalEntityId },
  currencyCode: 'CZK',
  unitBasis: {
    quantity: '1',
    unitRef: catalogRef('44444444-4444-4444-8444-444444444444', 'commerce.catalog.product-unit'),
  },
} as const;
const compatibilityEvidence = {
  catalogRevision: 7,
  definitionEffectivePeriod: { effectiveFrom: '2026-01-01T00:00:00.000Z', effectiveTo: null },
  definitionRevisionId: '55555555-5555-4555-8555-555555555555',
  definitionRevisionNumber: 4,
  meaningFingerprint: 'a'.repeat(64),
  priceGroupRef,
  requiredContract: { contractId: 'commerce.customer-price-group-assignment.v1', version: 1 },
  trustedOperationAt: effectiveAt,
  verifiedAt: effectiveAt,
} as const;
const resolutionInput = {
  _tag: 'ASSIGNED',
  effectiveAt,
  interpretation: {
    _tag: 'ASSIGNED',
    assignmentResolution: {
      _tag: 'ASSIGNED',
      assignmentRef: {
        moduleId: 'commerce.customer-context',
        resourceId: '88888888-8888-4888-8888-888888888888',
        resourceType: 'commerce.customer-context.customer-price-group-assignment',
        tenantId,
      },
      assignmentRevision: 3,
      compatibility: compatibilityEvidence,
      effectiveFrom: '2026-01-01T00:00:00.000Z',
      effectiveTo: null,
      priceGroupRef,
    },
    basis,
    compatibilityEvidence,
    discountAudience: { kind: 'PRICE_GROUP', priceGroupRef },
    priceGroupRef,
    priceSelector: { kind: 'PRICE_GROUP', priceGroupRef },
  },
} as const;
const supportRootRef = {
  moduleId: 'commerce.pricing',
  resourceId: supportRootId,
  resourceType: 'commerce.pricing.currency-support',
  tenantId,
} as const;
const supportRevisionRef = {
  moduleId: 'commerce.pricing',
  resourceId: supportRevisionId,
  resourceType: 'commerce.pricing.currency-support-revision',
  supportRootId,
  tenantId,
} as const;
const verificationRef = 'commerce.pricing.currency-support-proof:763-runtime-acceptance';
const currencySupport = {
  completenessEvidence: {
    observedAt,
    ownerRevision: supportRevisionId,
    scope: {
      kind: 'EXACT_PREDICATE',
      predicateRef: `commerce.pricing.current-supported-currencies:${tenantId}`,
    },
  },
  currentnessEvidence: {
    evaluatedAt: effectiveAt,
    evaluationMode: 'HISTORICAL_AS_OF',
    observedAt,
    scheduleRevision: 7,
    supportRevisionRef,
    supportRootRef,
  },
  effectiveAt,
  effectivePeriod: { effectiveFrom: '2026-09-01T00:00:00.000Z', effectiveTo: null },
  factProofs: [{ factRef: supportRootRef.resourceId, factRevisionRef: supportRevisionRef.resourceId, verificationRef }],
  generation: 7,
  observedAt,
  outcome: 'SUPPORTED_CURRENCIES_CURRENT',
  pricingRevision: 'pricing-currency-support:7',
  scheduleRevision: 7,
  supportedCurrencies: ['CZK'],
  supportRevisionRef,
  supportRootRef,
  tenantId,
  verificationRef,
} as const;
const input = Schema.decodeUnknownSync(ExactPriceResolutionInputSchema)({ currencySupport, resolutionInput });
const trusted = {
  legalEntityId,
  tenantId,
  trustedOperationAt: DateTime.makeUnsafe(effectiveAt),
} as const;
const freshSupport = {
  currentnessEvidence: {
    evaluatedAt: effectiveAt,
    evaluationMode: 'CURRENT_WITH_REVALIDATION',
    observedAt,
    revalidatedAt: '2026-09-27T12:00:00.060Z',
    scheduleRevision: 7,
    supportRevisionRef,
    supportRootRef,
  },
  effectivePeriod: currencySupport.effectivePeriod,
  generation: 7,
  observedAt,
  pricingRevision: currencySupport.pricingRevision,
  scheduleRevision: 7,
  supportedCurrencies: ['CZK'],
  supportRevisionRef,
  supportRootRef,
} as const;
const evidence = {
  effectiveAt,
  nextApplicabilityBoundary: '2026-10-01T00:00:00.000Z',
  observedAt,
  ownerRevision: 'pricing-current-state:41',
} as const;
const priceRef = {
  moduleId: 'commerce.pricing',
  resourceId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
  resourceType: 'commerce.pricing.price',
  tenantId,
} as const;
const found = (request: ExactPriceLookupRequest): ExactPriceLookupResult => ({
  _tag: 'FOUND',
  evidence,
  priceRef,
  priceRevision: {
    effectiveFrom: '2026-09-01T00:00:00.000Z',
    monetaryAmount: { amount: '0', currencyCode: request.exactKey.currencyCode },
    monetaryBoundary: 'PRE_TAX',
    revision: 2,
    revisionId: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
  },
  request,
});
const absent = (request: ExactPriceLookupRequest): ExactPriceLookupResult => ({ _tag: 'ABSENT', evidence, request });

describe('Issue #763 exact Price runtime acceptance', () => {
  it.effect('uses fresh Tenant support once and retains required Group absence before a zero no-group Price', () =>
    Effect.gen(function* assignedFallback() {
      let supportReads = 0;
      const requests: ExactPriceLookupRequest[] = [];
      const service = makeExactPriceResolutionService({
        loadCurrencySupport: () => {
          supportReads += 1;
          return Effect.succeed({ _tag: 'current' as const, current: freshSupport });
        },
        lookupExact: (request) => {
          requests.push(request);
          return Effect.succeed(
            request.exactKey.priceGroupSelector.kind === 'PRICE_GROUP' ? absent(request) : found(request),
          );
        },
      });

      const result = yield* service.resolve(input, trusted);
      expect(Schema.is(ExactPriceFoundResolutionSchema)(result)).toBe(true);
      const path = Match.value(result.path).pipe(
        Match.tag('NO_GROUP_AFTER_PROVEN_GROUP_ABSENCE', (value) => value),
        Match.orElse(() => null),
      );
      expect(Schema.is(ExactPriceLookupAbsentSchema)(path?.groupAbsence)).toBe(true);
      expect(Schema.is(ExactPriceLookupFoundSchema)(path?.usedPrice)).toBe(true);
      expect(path?.usedPrice.priceRevision.monetaryAmount).toEqual({ amount: '0', currencyCode: 'CZK' });
      expect(supportReads).toBe(1);
      expect(requests.map(({ exactKey }) => exactKey.priceGroupSelector.kind)).toEqual(['PRICE_GROUP', 'NO_GROUP']);
      expect(requests.map(({ exactKey }) => exactKey.catalogSelection)).toEqual([selection, selection]);
      expect(requests.map(({ exactKey }) => exactKey.commercialScope).every((scope) => scope.marketId === 'CZ')).toBe(
        true,
      );
    }),
  );

  it.effect(
    'fails closed before owner reads when trusted Tenant, SLE, or operation time does not bind the exact key',
    () =>
      Effect.gen(function* trustedScopeMismatch() {
        let supportReads = 0;
        let priceReads = 0;
        const service = makeExactPriceResolutionService({
          loadCurrencySupport: () => {
            supportReads += 1;
            return Effect.succeed({ _tag: 'current' as const, current: freshSupport });
          },
          lookupExact: (request) => {
            priceReads += 1;
            return Effect.succeed(found(request));
          },
        });

        const tenantMismatch = yield* service.resolve(input, {
          ...trusted,
          tenantId: 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee',
        });
        const legalEntityMismatch = yield* service.resolve(input, {
          ...trusted,
          legalEntityId: 'ffffffff-ffff-4fff-8fff-ffffffffffff',
        });
        const timeMismatch = yield* service.resolve(input, {
          ...trusted,
          trustedOperationAt: DateTime.makeUnsafe('2026-09-27T12:00:00.001Z'),
        });
        expect(Schema.is(ExactPriceConfigurationErrorResolutionSchema)(tenantMismatch)).toBe(true);
        expect(Schema.is(ExactPriceConfigurationErrorResolutionSchema)(legalEntityMismatch)).toBe(true);
        expect(Schema.is(ExactPriceIndeterminateResolutionSchema)(timeMismatch)).toBe(true);
        expect(supportReads).toBe(0);
        expect(priceReads).toBe(0);
      }),
  );

  it.effect('rejects stale or changed Currency Support without consulting Price or fabricating CZK/EUR fallback', () =>
    Effect.gen(function* staleSupport() {
      let priceReads = 0;
      const service = makeExactPriceResolutionService({
        loadCurrencySupport: () =>
          Effect.succeed({
            _tag: 'current' as const,
            current: { ...freshSupport, supportedCurrencies: ['CZK', 'EUR'] as const },
          }),
        lookupExact: (request) => {
          priceReads += 1;
          return Effect.succeed(found(request));
        },
      });

      const result = yield* service.resolve(input, trusted);
      expect(Schema.is(ExactPriceIndeterminateResolutionSchema)(result)).toBe(true);
      const path = Match.value(result.path).pipe(
        Match.tag('INDETERMINATE', (value) => value),
        Match.orElse(() => null),
      );
      expect(Schema.is(ExactPriceLookupUnverifiableSchema)(path?.lookup)).toBe(true);
      expect(path?.lookup).toMatchObject({ reason: 'CURRENTNESS_UNVERIFIABLE' });
      expect(priceReads).toBe(0);
      expect(input.currencySupport.supportedCurrencies).toEqual(['CZK']);
    }),
  );
});
