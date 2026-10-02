import { PersistenceFailure } from '@app/core-runtime';
import { ExactPriceResolutionInputSchema } from '@app/pricing-contracts/domain/exact-price-resolution';
import type { ExactPriceResolution } from '@app/pricing-contracts/domain/exact-price-resolution';
import type { ExactPriceLookupRequest } from '@app/pricing-contracts/domain/exact-price-lookup';
import type { PriceGroupFallbackResolution } from '@app/pricing-contracts/domain/price-group-fallback';
import { DateTime, Effect, Match, Schema } from 'effect';
import { describe, expect, it } from 'effect-rstest';

import { makeExactPriceResolutionService } from '../../src/services/exact-price-resolution.service.ts';

const tenantId = '11111111-1111-4111-8111-111111111111';
const legalEntityId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const effectiveAt = '2026-09-27T12:00:00.000Z';
const observedAt = '2026-09-27T12:00:00.050Z';
const revalidatedAt = '2026-09-27T12:00:00.100Z';
const supportRootId = '12121212-1212-4212-8212-121212121212';
const supportRevisionId = '13131313-1313-4313-8313-131313131313';

const catalogRef = <const ResourceType extends string>(resourceId: string, resourceType: ResourceType) => ({
  moduleId: 'commerce.catalog' as const,
  resourceId,
  resourceType,
  tenantId,
});
const productRef = catalogRef('22222222-2222-4222-8222-222222222222', 'commerce.catalog.product');
const variantRef = catalogRef('33333333-3333-4333-8333-333333333333', 'commerce.catalog.variant');
const priceGroupRef = {
  moduleId: 'pricing.price-group-catalog',
  resourceId: '77777777-7777-4777-8777-777777777777',
  resourceType: 'pricing.price-group-catalog.price-group',
  tenantId,
} as const;
const selection = {
  configuration: {
    choices: [{ choiceKey: 'finish', value: 'blue' }],
    definition: {
      resourceRef: catalogRef('88888888-8888-4888-8888-888888888888', 'commerce.catalog.configuration-definition'),
      revision: 4,
    },
    productRef,
    variantRef,
  },
  packageOption: {
    contentRevision: {
      resourceRef: catalogRef('99999999-9999-4999-8999-999999999999', 'commerce.catalog.package-definition'),
      revision: 5,
    },
    optionRef: catalogRef('99999999-9999-4999-8999-999999999999', 'commerce.catalog.package-definition'),
  },
  productRef,
  variantRef,
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
const verificationRef = 'commerce.pricing.currency-support-proof:exact-resolution-service';
const currencySupport = {
  completenessEvidence: {
    observedAt,
    ownerRevision: supportRevisionId,
    scope: { kind: 'EXACT_PREDICATE', predicateRef: `commerce.pricing.current-supported-currencies:${tenantId}` },
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
const input = Schema.decodeSync(ExactPriceResolutionInputSchema)({ currencySupport, resolutionInput });
const freshCurrencySupport = {
  currentnessEvidence: {
    evaluatedAt: revalidatedAt,
    evaluationMode: 'CURRENT_WITH_REVALIDATION',
    observedAt: revalidatedAt,
    revalidatedAt,
    scheduleRevision: 7,
    supportRevisionRef,
    supportRootRef,
  },
  effectivePeriod: currencySupport.effectivePeriod,
  generation: 7,
  observedAt: revalidatedAt,
  pricingRevision: 'pricing-currency-support:7',
  scheduleRevision: 7,
  supportedCurrencies: ['CZK'],
  supportRevisionRef,
  supportRootRef,
} as const;
const trusted = {
  legalEntityId,
  tenantId,
  trustedOperationAt: DateTime.makeUnsafe(effectiveAt),
} as const;
const priceRef = {
  moduleId: 'commerce.pricing',
  resourceId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
  resourceType: 'commerce.pricing.price',
  tenantId,
} as const;
const evidence = { effectiveAt, observedAt, ownerRevision: 'pricing-current-state:41' } as const;

const found = (request: ExactPriceLookupRequest) => ({
  _tag: 'FOUND' as const,
  evidence,
  priceRef,
  priceRevision: {
    effectiveFrom: '2026-09-01T00:00:00.000Z',
    monetaryAmount: { amount: '0', currencyCode: request.exactKey.currencyCode },
    monetaryBoundary: 'PRE_TAX' as const,
    revision: 2,
    revisionId: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
  },
  request,
});

const resolutionKind = (resolution: ExactPriceResolution) =>
  Match.value(resolution).pipe(
    Match.tag('PRICE_FOUND', () => 'PRICE_FOUND' as const),
    Match.tag('NO_APPLICABLE_PRICE', () => 'NO_APPLICABLE_PRICE' as const),
    Match.tag('PRICING_CONFLICT', () => 'PRICING_CONFLICT' as const),
    Match.tag('PRICING_CONFIGURATION_ERROR', () => 'PRICING_CONFIGURATION_ERROR' as const),
    Match.tag('PRICING_INDETERMINATE', () => 'PRICING_INDETERMINATE' as const),
    Match.exhaustive,
  );

const pathKind = (path: PriceGroupFallbackResolution) =>
  Match.value(path).pipe(
    Match.tag('GROUP_PRICE', () => 'GROUP_PRICE' as const),
    Match.tag('NO_GROUP_NONE', () => 'NO_GROUP_NONE' as const),
    Match.tag('NO_GROUP_GUEST', () => 'NO_GROUP_GUEST' as const),
    Match.tag('NO_GROUP_AFTER_PROVEN_GROUP_ABSENCE', () => 'NO_GROUP_AFTER_PROVEN_GROUP_ABSENCE' as const),
    Match.tag('NO_APPLICABLE_PRICE', () => 'NO_APPLICABLE_PRICE' as const),
    Match.tag('CONFIGURATION_ERROR', () => 'CONFIGURATION_ERROR' as const),
    Match.tag('CONFLICT', () => 'CONFLICT' as const),
    Match.tag('INDETERMINATE', () => 'INDETERMINATE' as const),
    Match.exhaustive,
  );

const requireIndeterminate = (path: PriceGroupFallbackResolution) =>
  Match.value(path).pipe(
    Match.tag('INDETERMINATE', (value) => value),
    Match.orElse(() => {
      throw new Error('Expected an indeterminate exact Price path');
    }),
  );

describe('exact Price resolution service', () => {
  it.effect('uses only proven Group absence to consult the identical no-group key', () =>
    Effect.gen(function* resolveFallback() {
      const requests: ExactPriceLookupRequest[] = [];
      const service = makeExactPriceResolutionService({
        loadCurrencySupport: () => Effect.succeed({ _tag: 'current', current: freshCurrencySupport }),
        lookupExact: (request) => {
          requests.push(request);
          return Effect.succeed(
            request.exactKey.priceGroupSelector.kind === 'PRICE_GROUP'
              ? { _tag: 'ABSENT' as const, evidence, request }
              : found(request),
          );
        },
      });

      const result = yield* service.resolve(input, trusted);
      expect(resolutionKind(result)).toBe('PRICE_FOUND');
      expect(pathKind(result.path)).toBe('NO_GROUP_AFTER_PROVEN_GROUP_ABSENCE');
      expect(requests).toHaveLength(2);
      expect(requests[0]?.exactKey.priceGroupSelector.kind).toBe('PRICE_GROUP');
      expect(requests[1]?.exactKey.priceGroupSelector).toEqual({ kind: 'NO_GROUP' });
      expect(requests[1]?.exactKey.catalogSelection).toEqual(selection);
      expect(requests[1]?.exactKey.currencyCode).toBe('CZK');
    }),
  );

  it.effect('maps distinct same-key truths to conflict without comparing their amounts', () =>
    Effect.gen(function* retainConflict() {
      let lookupCalls = 0;
      const service = makeExactPriceResolutionService({
        loadCurrencySupport: () => Effect.succeed({ _tag: 'current', current: freshCurrencySupport }),
        lookupExact: (request) => {
          lookupCalls += 1;
          const claimant = (resourceId: string, revisionId: string, provenanceRef: string) => ({
            effectivePeriod: { effectiveFrom: '2026-09-01T00:00:00.000Z' as const, effectiveTo: null },
            exactKey: request.exactKey,
            priceRef: { ...priceRef, resourceId },
            priceRevision: {
              effectiveFrom: '2026-09-01T00:00:00.000Z' as const,
              monetaryAmount: { amount: '900', currencyCode: request.exactKey.currencyCode },
              monetaryBoundary: 'PRE_TAX' as const,
              revision: 2,
              revisionId,
            },
            priceScheduleRevisionId: revisionId,
            provenanceRefs: [provenanceRef],
            scheduleRevision: 2,
          });
          return Effect.succeed({
            _tag: 'EXACT_PRICE_CONFLICT_DIAGNOSTIC' as const,
            claimants: [
              claimant(
                'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
                'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
                '10101010-1010-4010-8010-101010101010',
              ),
              claimant(
                'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
                'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee',
                '20202020-2020-4020-8020-202020202020',
              ),
            ],
            evidence,
            reason: 'COMPETING_CURRENT_EXACT_PRICES' as const,
            request,
            verification: 'OWNER_VERIFIED_COMPLETE_CURRENT_SET' as const,
          });
        },
      });

      const result = yield* service.resolve(input, trusted);
      expect(resolutionKind(result)).toBe('PRICING_CONFLICT');
      expect(pathKind(result.path)).toBe('CONFLICT');
      expect(lookupCalls).toBe(1);
    }),
  );

  it.effect('fails closed before Price persistence when Currency Support cannot be freshly revalidated', () =>
    Effect.gen(function* rejectStaleSupport() {
      let lookupCalls = 0;
      const service = makeExactPriceResolutionService({
        loadCurrencySupport: () =>
          Effect.succeed({
            _tag: 'current',
            current: { ...freshCurrencySupport, scheduleRevision: 8 },
          }),
        lookupExact: (request) => {
          lookupCalls += 1;
          return Effect.succeed(found(request));
        },
      });

      const result = yield* service.resolve(input, trusted);
      expect(resolutionKind(result)).toBe('PRICING_INDETERMINATE');
      expect(pathKind(result.path)).toBe('INDETERMINATE');
      expect(lookupCalls).toBe(0);
    }),
  );

  it.effect('keeps unavailable support distinct and performs no Price lookup', () =>
    Effect.gen(function* unavailableSupport() {
      let lookupCalls = 0;
      const service = makeExactPriceResolutionService({
        loadCurrencySupport: () =>
          Effect.fail(
            new PersistenceFailure({ cause: 'fixture driver failure', reason: 'Currency Support unavailable' }),
          ),
        lookupExact: (request) => {
          lookupCalls += 1;
          return Effect.succeed(found(request));
        },
      });

      const result = yield* service.resolve(input, trusted);
      expect(resolutionKind(result)).toBe('PRICING_INDETERMINATE');
      expect(pathKind(result.path)).toBe('INDETERMINATE');
      expect(requireIndeterminate(result.path).reason).toBe('OWNER_STATE_UNAVAILABLE');
      expect(lookupCalls).toBe(0);
    }),
  );

  it.effect('keeps Currency Support conflict distinct from exact Price conflict', () =>
    Effect.gen(function* retainSupportConflict() {
      let lookupCalls = 0;
      const service = makeExactPriceResolutionService({
        loadCurrencySupport: () =>
          Effect.succeed({
            _tag: 'conflict',
            candidateRevisionIds: ['14141414-1414-4414-8414-141414141414', '15151515-1515-4515-8515-151515151515'],
            observedAt,
          }),
        lookupExact: (request) => {
          lookupCalls += 1;
          return Effect.succeed(found(request));
        },
      });

      const result = yield* service.resolve(input, trusted);
      expect(resolutionKind(result)).toBe('PRICING_INDETERMINATE');
      expect(pathKind(result.path)).toBe('INDETERMINATE');
      expect(requireIndeterminate(result.path).reason).toBe('OWNER_STATE_UNVERIFIABLE');
      expect(lookupCalls).toBe(0);
    }),
  );

  it.effect('rejects a trusted SLE mismatch before owner reads', () =>
    Effect.gen(function* rejectScopeMismatch() {
      let supportCalls = 0;
      let lookupCalls = 0;
      const service = makeExactPriceResolutionService({
        loadCurrencySupport: () => {
          supportCalls += 1;
          return Effect.succeed({ _tag: 'current', current: freshCurrencySupport });
        },
        lookupExact: (request) => {
          lookupCalls += 1;
          return Effect.succeed(found(request));
        },
      });

      const result = yield* service.resolve(input, {
        ...trusted,
        legalEntityId: 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee',
      });
      expect(resolutionKind(result)).toBe('PRICING_CONFIGURATION_ERROR');
      expect(supportCalls).toBe(0);
      expect(lookupCalls).toBe(0);
    }),
  );

  it.effect('preserves a future owner-enabled native EUR key without CZK fallback or FX', () =>
    Effect.gen(function* preserveNativeCurrency() {
      const eurInput = yield* Schema.decodeEffect(ExactPriceResolutionInputSchema)({
        currencySupport: { ...currencySupport, supportedCurrencies: ['EUR'] },
        resolutionInput: {
          ...resolutionInput,
          interpretation: {
            ...resolutionInput.interpretation,
            basis: { ...basis, currencyCode: 'EUR' },
          },
        },
      });
      const requests: ExactPriceLookupRequest[] = [];
      const service = makeExactPriceResolutionService({
        loadCurrencySupport: () =>
          Effect.succeed({
            _tag: 'current',
            current: { ...freshCurrencySupport, supportedCurrencies: ['EUR'] },
          }),
        lookupExact: (request) => {
          requests.push(request);
          return Effect.succeed(found(request));
        },
      });

      const result = yield* service.resolve(eurInput, trusted);
      expect(resolutionKind(result)).toBe('PRICE_FOUND');
      expect(requests).toHaveLength(1);
      expect(requests[0]?.exactKey.currencyCode).toBe('EUR');
      expect(result.currencySupport.supportedCurrencies).toEqual(['EUR']);
    }),
  );
});
