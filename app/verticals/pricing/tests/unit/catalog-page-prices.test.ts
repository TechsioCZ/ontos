import { TrustedPrincipalContextSchema } from '@app/core-runtime';
import { makeAccessDecisionService } from '@app/core-runtime/access/enforcement';
import type { AccessPrincipalKind, GateInput } from '@app/core-runtime/access/enforcement';
import { LegalEntityIdSchema } from '@app/core-runtime/access/ids';
import type { ExactPriceLookupRequest } from '@app/pricing-contracts/domain/exact-price-lookup';
import type { ExactPriceResolution } from '@app/pricing-contracts/domain/exact-price-resolution';
import { DateTime, Effect, Match, Option, Schema } from 'effect';
import { describe, expect, it } from 'effect-rstest';

import {
  at,
  cell,
  makeAuthority,
  makeCheck,
  person,
  tenant,
} from '../../../../packages/core-runtime/tests/unit/access-decision-support.ts';
import { CatalogPagePricesRequestSchema } from '../../shared/apis/catalog-page-prices.ts';
import type { CatalogPagePrice, CatalogPagePriceItem } from '../../shared/apis/catalog-page-prices.ts';
import { catalogPagePricesRead } from '../../src/api/catalog-page-prices.read.ts';
import { readCatalogPagePrices } from '../../src/services/catalog-page-prices.service.ts';
import type { CatalogPagePricesOwnerReads } from '../../src/services/catalog-page-prices.service.ts';
import { makeExactPriceResolutionService } from '../../src/services/exact-price-resolution.service.ts';
import type { ExactPriceResolutionDependencies } from '../../src/services/exact-price-resolution.service.ts';
import { ReadCurrentQuantityTierSetPersistenceOutcomeSchema } from '../../src/services/quantity-tier-persistence.service.ts';

const tenantId = '11111111-1111-4111-8111-111111111111';
const legalEntityId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const effectiveAt = '2026-11-21T09:00:00.000Z';
const observedAt = '2026-11-21T09:00:00.050Z';
const supportRootId = '12121212-1212-4212-8212-121212121212';
const supportRevisionId = '13131313-1313-4313-8313-131313131313';
const verificationRef = 'commerce.pricing.currency-support-proof:catalog-page-prices';
const trusted = { legalEntityId, tenantId, trustedOperationAt: DateTime.makeUnsafe(effectiveAt) } as const;

const catalogRef = <const ResourceType extends string>(resourceId: string, resourceType: ResourceType) => ({
  moduleId: 'commerce.catalog' as const,
  resourceId,
  resourceType,
  tenantId,
});
const productRef = catalogRef('22222222-2222-4222-8222-222222222222', 'commerce.catalog.product');
const unitRef = catalogRef('44444444-4444-4444-8444-444444444444', 'commerce.catalog.product-unit');
const variantIds = {
  absent: '33333333-3333-4333-8333-333333333332',
  conflict: '33333333-3333-4333-8333-333333333333',
  priced: '33333333-3333-4333-8333-333333333331',
  tiered: '33333333-3333-4333-8333-333333333334',
} as const;
const itemFor = (variantId: string) => ({
  catalogSelection: { productRef, variantRef: catalogRef(variantId, 'commerce.catalog.variant') },
  unitBasis: { quantity: '1', unitRef },
});
const request = Schema.decodeUnknownSync(CatalogPagePricesRequestSchema)({
  channelId: 'B2C',
  currencyCode: 'CZK',
  items: [
    itemFor(variantIds.priced),
    itemFor(variantIds.absent),
    itemFor(variantIds.conflict),
    itemFor(variantIds.tiered),
  ],
  marketId: 'cz',
});

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
/** The Current Tenant Currency Support proof the owner issues: revalidated, with its durable receipt. */
const storedSupport = {
  currentnessEvidence: {
    evaluatedAt: effectiveAt,
    evaluationMode: 'CURRENT_WITH_REVALIDATION',
    observedAt,
    revalidatedAt: observedAt,
    scheduleRevision: 7,
    supportRevisionRef,
    supportRootRef,
  },
  effectivePeriod: { effectiveFrom: '2026-09-01T00:00:00.000Z', effectiveTo: null },
  factProofs: [{ factRef: supportRootId, factRevisionRef: supportRevisionId, verificationRef }],
  generation: 7,
  observedAt,
  predicateRef: `commerce.pricing.current-supported-currencies:${tenantId}`,
  pricingRevision: 'pricing-currency-support:7',
  scheduleRevision: 7,
  supportedCurrencies: ['CZK'],
  supportRevisionRef,
  supportRootRef,
  verificationRef,
} as const;

const priceRefFor = (resourceId: string) => ({
  moduleId: 'commerce.pricing' as const,
  resourceId,
  resourceType: 'commerce.pricing.price' as const,
  tenantId,
});
const pricedRef = priceRefFor('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb1');
const tieredRef = priceRefFor('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb4');
const evidence = { effectiveAt, observedAt, ownerRevision: 'pricing-current-state:41' } as const;
const found = (lookup: ExactPriceLookupRequest, priceRef: typeof pricedRef, amount: string, revisionId: string) => ({
  _tag: 'FOUND' as const,
  evidence,
  priceRef,
  priceRevision: {
    effectiveFrom: '2026-09-01T00:00:00.000Z',
    monetaryAmount: { amount, currencyCode: lookup.exactKey.currencyCode },
    monetaryBoundary: 'PRE_TAX' as const,
    revision: 2,
    revisionId,
  },
  request: lookup,
});
const claimant = (lookup: ExactPriceLookupRequest, resourceId: string, revisionId: string, provenanceRef: string) => ({
  effectivePeriod: { effectiveFrom: '2026-09-01T00:00:00.000Z' as const, effectiveTo: null },
  exactKey: lookup.exactKey,
  priceRef: priceRefFor(resourceId),
  priceRevision: {
    effectiveFrom: '2026-09-01T00:00:00.000Z' as const,
    monetaryAmount: { amount: '900', currencyCode: lookup.exactKey.currencyCode },
    monetaryBoundary: 'PRE_TAX' as const,
    revision: 1,
    revisionId,
  },
  priceScheduleRevisionId: revisionId,
  provenanceRefs: [provenanceRef],
  scheduleRevision: 1,
});

/** One owner Price state per variant, answered exactly as the native exact lookup answers it. */
const lookupExact =
  (lookups: ExactPriceLookupRequest[]): ExactPriceResolutionDependencies['lookupExact'] =>
  (lookup) => {
    lookups.push(lookup);
    const variantId = lookup.exactKey.catalogSelection.variantRef.resourceId;
    if (variantId === variantIds.priced) {
      return Effect.succeed(found(lookup, pricedRef, '120.500000000', 'cccccccc-cccc-4ccc-8ccc-ccccccccccc1'));
    }
    if (variantId === variantIds.tiered) {
      return Effect.succeed(found(lookup, tieredRef, '100.000000000', 'cccccccc-cccc-4ccc-8ccc-ccccccccccc4'));
    }
    if (variantId === variantIds.conflict) {
      return Effect.succeed({
        _tag: 'EXACT_PRICE_CONFLICT_DIAGNOSTIC' as const,
        claimants: [
          claimant(
            lookup,
            'dddddddd-dddd-4ddd-8ddd-ddddddddddd1',
            'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeee1',
            '10101010-1010-4010-8010-101010101010',
          ),
          claimant(
            lookup,
            'dddddddd-dddd-4ddd-8ddd-ddddddddddd2',
            'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeee2',
            '20202020-2020-4020-8020-202020202020',
          ),
        ],
        evidence,
        reason: 'COMPETING_CURRENT_EXACT_PRICES' as const,
        request: lookup,
        verification: 'OWNER_VERIFIED_COMPLETE_CURRENT_SET' as const,
      });
    }
    return Effect.succeed({ _tag: 'ABSENT' as const, evidence, request: lookup });
  };

const tierAuthority = {
  generation: 3,
  observedAt,
  ownerRevision: 'pricing-quantity-tier-set:3',
  ownerRootRef: 'pricing-quantity-tier-set-root:tiered',
  predicateRef: 'pricing-quantity-tier-set-predicate:tiered',
  verificationRef: 'commerce.pricing.quantity-tier-set-proof:tiered',
} as const;
const tier = (revisionId: string, thresholdQuantity: string, amount: string) => ({
  definition: {
    identityKey: {
      priceRef: tieredRef,
      quantityBasis: {
        catalogQuantityBasis: {
          targetDivisibilityRevision: 1,
          targetRef: catalogRef(variantIds.tiered, 'commerce.catalog.variant'),
          unitRef,
          unitRuleRevision: 1,
        },
        priceUnitBasis: { quantity: '1', unitRef },
      },
      thresholdQuantity,
    },
    revision: {
      effectiveFrom: '2026-09-01T00:00:00.000Z',
      monetaryBoundary: 'PRE_TAX',
      resultingUnitPrice: { amount, currencyCode: 'CZK' },
      revision: 1,
      revisionId,
    },
  },
  effectivePeriod: { effectiveFrom: '2026-09-01T00:00:00.000Z', effectiveTo: null },
  lineage: { correctedRevisionId: null, kind: 'INITIAL', previousRevisionId: null },
});
/** The owner-proven Current Tier set of the tiered Price; the owner order is not the threshold order. */
const decodedTieredSet = Schema.decodeUnknownSync(ReadCurrentQuantityTierSetPersistenceOutcomeSchema)({
  authority: tierAuthority,
  outcome: 'QUANTITY_TIER_SET_CURRENT',
  tierSet: {
    authority: tierAuthority,
    completenessEvidence: {
      observedAt,
      ownerRevision: tierAuthority.ownerRevision,
      scope: { kind: 'EXACT_PREDICATE', predicateRef: tierAuthority.predicateRef },
    },
    currentTiers: [
      tier('f0f0f0f0-f0f0-40f0-80f0-f0f0f0f0f050', '50', '80.000000000'),
      tier('f0f0f0f0-f0f0-40f0-80f0-f0f0f0f0f010', '10', '90.000000000'),
    ],
    factProofs: [
      {
        factRef: 'tier-50',
        factRevisionRef: 'f0f0f0f0-f0f0-40f0-80f0-f0f0f0f0f050',
        verificationRef: tierAuthority.verificationRef,
      },
      {
        factRef: 'tier-10',
        factRevisionRef: 'f0f0f0f0-f0f0-40f0-80f0-f0f0f0f0f010',
        verificationRef: tierAuthority.verificationRef,
      },
    ],
    priceRef: tieredRef,
  },
});
if (decodedTieredSet.outcome !== 'QUANTITY_TIER_SET_CURRENT') {
  throw new Error('Expected the owner-proven Current Tier set fixture');
}
const tieredSet = decodedTieredSet;

/** The owner-proven tier set the fixture answers for one Price: the tiered one, or an empty Current set. */
const tierSetFor = (priceRef: typeof pricedRef) =>
  priceRef.resourceId === tieredRef.resourceId
    ? tieredSet
    : { ...tieredSet, tierSet: { ...tieredSet.tierSet, currentTiers: [], factProofs: [], priceRef } };

const harness = (
  options: { readonly support?: 'absent' | 'current'; readonly tiers?: 'current' | 'unavailable' } = {},
) => {
  const lookups: ExactPriceLookupRequest[] = [];
  const exactDependencies: ExactPriceResolutionDependencies = {
    loadCurrencySupport: () =>
      Effect.succeed(
        options.support === 'absent'
          ? { _tag: 'absent' as const, observedAt }
          : { _tag: 'current' as const, current: storedSupport },
      ),
    lookupExact: lookupExact(lookups),
  };
  const owner: CatalogPagePricesOwnerReads = {
    loadCurrencySupport: exactDependencies.loadCurrencySupport,
    readCurrentQuantityTierSet: ({ priceRef }) =>
      Effect.succeed(
        options.tiers === 'unavailable'
          ? {
              outcome: 'QUANTITY_TIER_SET_AUTHORITY_UNAVAILABLE' as const,
              priceRef,
              reason: 'The Tier set authority is unavailable',
              retryable: true as const,
            }
          : tierSetFor(priceRef),
      ),
    resolveExactPrice: makeExactPriceResolutionService(exactDependencies).resolve,
  };
  return { exactDependencies, lookups, read: () => readCatalogPagePrices(request, trusted, owner) };
};

type PageResult = Effect.Success<ReturnType<typeof readCatalogPagePrices>>;

const pricesOf = (result: PageResult) =>
  Match.value(result).pipe(
    Match.tag('CATALOG_PAGE_PRICED', ({ prices }) => prices),
    Match.tag('CURRENCY_SUPPORT_NOT_CURRENT', () => {
      throw new Error('Expected a priced catalogue page');
    }),
    Match.exhaustive,
  );

/** One variant's public answer, with its outcome named `kind` so the page and the one-item resolution compare. */
const answerOf = (price: CatalogPagePrice) =>
  Match.value(price).pipe(
    Match.tag('PRICE_FOUND', ({ channelId, priceGroupSelector, priceRef, priceRevision }) => ({
      channelId,
      kind: 'PRICE_FOUND',
      priceGroupSelector,
      priceRef,
      priceRevision,
    })),
    Match.tag('NO_APPLICABLE_PRICE', ({ retryable }) => ({ kind: 'NO_APPLICABLE_PRICE', retryable })),
    Match.tag('PRICING_CONFLICT', ({ reason, retryable }) => ({ kind: 'PRICING_CONFLICT', reason, retryable })),
    Match.tag('PRICING_CONFIGURATION_ERROR', ({ reason, retryable }) => ({
      kind: 'PRICING_CONFIGURATION_ERROR',
      reason,
      retryable,
    })),
    Match.tag('PRICING_INDETERMINATE', ({ reason, retryable }) => ({
      kind: 'PRICING_INDETERMINATE',
      reason,
      retryable,
    })),
    Match.exhaustive,
  );

/** What the one-item exact resolution itself says about a variant, in the same vocabulary. */
const oneItemAnswerOf = (resolution: ExactPriceResolution) =>
  Match.value(resolution.path).pipe(
    Match.tag('NO_GROUP_GUEST', ({ usedPrice }) => ({
      channelId: usedPrice.request.exactKey.commercialScope.channelId,
      kind: 'PRICE_FOUND',
      priceGroupSelector: usedPrice.request.exactKey.priceGroupSelector,
      priceRef: usedPrice.priceRef,
      priceRevision: usedPrice.priceRevision,
    })),
    Match.tag('NO_APPLICABLE_PRICE', () => ({ kind: 'NO_APPLICABLE_PRICE', retryable: false })),
    Match.tag('CONFLICT', ({ reason }) => ({ kind: 'PRICING_CONFLICT', reason, retryable: false })),
    Match.tag('CONFIGURATION_ERROR', ({ reason }) => ({
      kind: 'PRICING_CONFIGURATION_ERROR',
      reason,
      retryable: false,
    })),
    Match.tag('INDETERMINATE', ({ reason }) => ({ kind: 'PRICING_INDETERMINATE', reason, retryable: true })),
    Match.orElse(() => ({ kind: 'NOT_A_GUEST_PATH' })),
  );

/** The variant at one position of the page; a missing one fails the test rather than being skipped. */
const nth = (prices: readonly CatalogPagePrice[], index: number): CatalogPagePrice => {
  const price = prices[index];
  if (price === undefined) {
    throw new Error(`Expected a priced variant at position ${index}`);
  }
  return price;
};

/** The Quantity Tiers a found variant carries, or why it carries none. */
const tiersOf = (price: CatalogPagePrice) =>
  Match.value(price).pipe(
    Match.tag('PRICE_FOUND', ({ quantityTiers }) =>
      Match.value(quantityTiers).pipe(
        Match.tag('QUANTITY_TIERS_CURRENT', ({ tiers }) => ({ kind: 'CURRENT', tiers })),
        Match.tag('QUANTITY_TIERS_UNAVAILABLE', ({ retryable }) => ({ kind: 'UNAVAILABLE', retryable })),
        Match.exhaustive,
      ),
    ),
    Match.orElse(() => ({ kind: 'NOT_FOUND' })),
  );

const guestInputFor = (
  item: CatalogPagePriceItem,
  currencySupport: Parameters<CatalogPagePricesOwnerReads['resolveExactPrice']>[0]['currencySupport'],
) => ({
  currencySupport,
  resolutionInput: {
    _tag: 'GUEST' as const,
    basis: {
      catalogSelection: item.catalogSelection,
      commercialScope: {
        channelId: request.channelId,
        marketId: request.marketId,
        sellingLegalEntityId: legalEntityId,
      },
      currencyCode: request.currencyCode,
      unitBasis: item.unitBasis,
    },
    effectiveAt,
  },
});

describe('catalogue page Prices', () => {
  it('accepts one to a hundred variants of one Tenant and nothing beyond', () => {
    const decode = Schema.decodeUnknownOption(CatalogPagePricesRequestSchema);
    const encoded = { ...request, items: [itemFor(variantIds.priced)] };
    expect(Option.isSome(decode(encoded))).toBe(true);
    expect(Option.isNone(decode({ ...encoded, items: [] }))).toBe(true);
    expect(
      Option.isNone(decode({ ...encoded, items: Array.from({ length: 101 }, () => itemFor(variantIds.priced)) })),
    ).toBe(true);
    expect(
      Option.isSome(decode({ ...encoded, items: Array.from({ length: 100 }, () => itemFor(variantIds.priced)) })),
    ).toBe(true);
    const foreignUnit = {
      ...itemFor(variantIds.priced),
      unitBasis: { quantity: '1', unitRef: { ...unitRef, tenantId: legalEntityId } },
    };
    expect(Option.isNone(decode({ ...encoded, items: [foreignUnit] }))).toBe(true);
    expect(Option.isNone(decode({ ...encoded, channelId: 'RETAIL' }))).toBe(true);
    expect(Option.isNone(decode({ ...encoded, marketId: '*' }))).toBe(true);
  });

  it.effect('answers every variant of one call in request order with its own exact outcome', () =>
    Effect.gen(function* pricesThePage() {
      const { lookups, read } = harness();
      const prices = pricesOf(yield* read());
      expect(prices.map(({ catalogSelection, unitBasis }) => ({ catalogSelection, unitBasis }))).toEqual(request.items);
      expect(prices.map(answerOf)).toEqual([
        {
          channelId: 'B2C',
          kind: 'PRICE_FOUND',
          priceGroupSelector: { kind: 'NO_GROUP' },
          priceRef: pricedRef,
          priceRevision: {
            effectiveFrom: '2026-09-01T00:00:00.000Z',
            monetaryAmount: { amount: '120.500000000', currencyCode: 'CZK' },
            monetaryBoundary: 'PRE_TAX',
            revision: 2,
            revisionId: 'cccccccc-cccc-4ccc-8ccc-ccccccccccc1',
          },
        },
        { kind: 'NO_APPLICABLE_PRICE', retryable: false },
        { kind: 'PRICING_CONFLICT', reason: 'COMPETING_CURRENT_EXACT_PRICES', retryable: false },
        {
          channelId: 'B2C',
          kind: 'PRICE_FOUND',
          priceGroupSelector: { kind: 'NO_GROUP' },
          priceRef: tieredRef,
          priceRevision: {
            effectiveFrom: '2026-09-01T00:00:00.000Z',
            monetaryAmount: { amount: '100.000000000', currencyCode: 'CZK' },
            monetaryBoundary: 'PRE_TAX',
            revision: 2,
            revisionId: 'cccccccc-cccc-4ccc-8ccc-ccccccccccc4',
          },
        },
      ]);
      expect(tiersOf(nth(prices, 0))).toEqual({ kind: 'CURRENT', tiers: [] });
      // An anonymous visitor is the owner's Guest: only the exact no-group key of the trusted company is read.
      expect(lookups).toHaveLength(4);
      for (const lookup of lookups) {
        expect(lookup.effectiveAt).toBe(effectiveAt);
        expect(lookup.exactKey.priceGroupSelector).toEqual({ kind: 'NO_GROUP' });
        expect(lookup.exactKey.commercialScope).toEqual({
          channelId: 'B2C',
          marketId: 'cz',
          sellingLegalEntityId: legalEntityId,
        });
        expect(lookup.exactKey.currencyCode).toBe('CZK');
      }
    }),
  );

  it.effect('lists the Current Quantity Tiers of the used Price, lowest threshold first', () =>
    Effect.gen(function* listsTiers() {
      const prices = pricesOf(yield* harness().read());
      expect(tiersOf(nth(prices, 3))).toEqual({
        kind: 'CURRENT',
        tiers: [
          {
            monetaryBoundary: 'PRE_TAX',
            thresholdQuantity: '10',
            unitPrice: { amount: '90.000000000', currencyCode: 'CZK' },
          },
          {
            monetaryBoundary: 'PRE_TAX',
            thresholdQuantity: '50',
            unitPrice: { amount: '80.000000000', currencyCode: 'CZK' },
          },
        ],
      });
      const unavailable = pricesOf(yield* harness({ tiers: 'unavailable' }).read());
      expect(answerOf(nth(unavailable, 3))).toMatchObject({ kind: 'PRICE_FOUND', priceRef: tieredRef });
      expect(tiersOf(nth(unavailable, 3))).toEqual({ kind: 'UNAVAILABLE', retryable: true });
    }),
  );

  it.effect('prices nothing when Tenant Currency Support has no Current proof at the instant', () =>
    Effect.gen(function* noCurrentSupport() {
      const { lookups, read } = harness({ support: 'absent' });
      const answer = Match.value(yield* read()).pipe(
        Match.tag('CURRENCY_SUPPORT_NOT_CURRENT', ({ currencySupport, effectiveAt: evaluatedAt }) => ({
          evaluatedAt,
          outcome: currencySupport.outcome,
        })),
        Match.tag('CATALOG_PAGE_PRICED', () => ({ evaluatedAt: effectiveAt, outcome: 'PRICED' })),
        Match.exhaustive,
      );
      expect(answer).toEqual({ evaluatedAt: effectiveAt, outcome: 'SUPPORTED_CURRENCIES_UNAVAILABLE' });
      expect(lookups).toHaveLength(0);
    }),
  );

  it.effect('gives each variant exactly the answer the one-item exact resolution gives for the same inputs', () =>
    Effect.gen(function* equivalence() {
      const { exactDependencies, read } = harness();
      const prices = pricesOf(yield* read());
      const oneItem = makeExactPriceResolutionService(exactDependencies);
      const currencySupport = {
        completenessEvidence: {
          observedAt,
          ownerRevision: supportRevisionId,
          scope: { kind: 'EXACT_PREDICATE' as const, predicateRef: storedSupport.predicateRef },
        },
        currentnessEvidence: storedSupport.currentnessEvidence,
        effectiveAt,
        effectivePeriod: storedSupport.effectivePeriod,
        factProofs: storedSupport.factProofs,
        generation: storedSupport.generation,
        observedAt,
        outcome: 'SUPPORTED_CURRENCIES_CURRENT' as const,
        pricingRevision: storedSupport.pricingRevision,
        scheduleRevision: storedSupport.scheduleRevision,
        supportedCurrencies: storedSupport.supportedCurrencies,
        supportRevisionRef,
        supportRootRef,
        tenantId,
        verificationRef,
      };
      const direct = yield* Effect.forEach(
        request.items,
        (item) => oneItem.resolve(guestInputFor(item, currencySupport), trusted),
        { concurrency: 1 },
      );
      expect(prices.map(answerOf)).toEqual(direct.map(oneItemAnswerOf));
      expect(direct.map(oneItemAnswerOf).map(({ kind }) => kind)).toEqual([
        'PRICE_FOUND',
        'NO_APPLICABLE_PRICE',
        'PRICING_CONFLICT',
        'PRICE_FOUND',
      ]);
    }),
  );
});

/*
 * Who may run the read is answered by Core's own decision service over the read's real carriers; only its identity,
 * workload registry and role-cell ports are scripted.
 */
const gateCompany = LegalEntityIdSchema.make('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaab');
const otherCompany = LegalEntityIdSchema.make('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaac');
const now = at('2026-11-21T09:00:00.000Z');
const carrier: GateInput['carrier'] = {
  accessDeclaration: catalogPagePricesRead.descriptor.accessDeclaration,
  accessWorkload: catalogPagePricesRead.descriptor.accessWorkload,
};
const capability = 'commerce.pricing.price.read-catalog-page';
const callerScope = (kind: 'api_key' | 'session', legalEntity: string = gateCompany) => ({
  ...Schema.decodeUnknownSync(TrustedPrincipalContextSchema)({
    authBindingId: '44444444-4444-4444-8444-444444444444',
    authContextRef: `${kind}:catalog-page-prices`,
    authMethod: kind,
    legalEntityId: legalEntity,
    principalId: person,
    tenantId: tenant,
  }),
  correlationId: 'catalog-page-prices-admission',
});
const gateFor = (options: {
  readonly cells?: readonly string[];
  readonly companies?: readonly string[];
  readonly keys?: readonly string[];
  readonly kind: AccessPrincipalKind;
}) => {
  const authority = {
    cells: (options.cells ?? []).map((key) => cell({ capability: key })),
    legalEntityScope: { _tag: 'LegalEntity' as const, legalEntityId: gateCompany, tenantId: tenant },
  };
  return makeAccessDecisionService({
    authorityFor: () => makeAuthority(authority).port,
    check: makeCheck({ authority }).port,
    decisionLog: { record: () => Effect.void },
    legalEntities: { listCandidateIds: () => Effect.succeed([gateCompany]) },
    principalKinds: { readKind: () => Effect.succeed(Option.some(options.kind)) },
    workloadBindings: {
      readWorkloadAuthority: () =>
        Effect.succeed({
          activeCompanyIds: new Set((options.companies ?? [gateCompany]).map((id) => LegalEntityIdSchema.make(id))),
          workloadKeys: new Set(options.keys),
        }),
    },
  });
};
const decide = (options: Parameters<typeof gateFor>[0], scope: ReturnType<typeof callerScope>) =>
  gateFor(options)
    .decide({ carrier, legalEntityScope: 'required', now, scope })
    .pipe(Effect.map((decision) => ({ codes: decision.reasons.map(({ code }) => code), outcome: decision.outcome })));

describe('catalogue page Price admission', () => {
  it('declares the storefront workload beside the staff capability, in one required company', () => {
    const { descriptor } = catalogPagePricesRead;
    expect(descriptor.accessWorkload?.workloads).toEqual(['commerce.storefront-client']);
    expect(descriptor.accessDeclaration).toMatchObject({
      key: capability,
      kind: 'read',
      modes: ['run'],
      risk: 'sensitive',
    });
    expect(descriptor.legalEntityScope).toBe('required');
  });

  it.effect('admits the storefront service principal bound to commerce.storefront-client in its own company', () =>
    Effect.gen(function* boundStorefront() {
      expect(yield* decide({ keys: ['commerce.storefront-client'], kind: 'service' }, callerScope('api_key'))).toEqual({
        codes: ['allow.workload'],
        outcome: 'ALLOWED',
      });
    }),
  );

  it.effect('refuses an unbound storefront principal, another workload and another company', () =>
    Effect.gen(function* unboundStorefront() {
      const refused = { codes: ['deny.workload_unbound'], outcome: 'DENIED' };
      expect(yield* decide({ kind: 'service' }, callerScope('api_key'))).toEqual(refused);
      expect(yield* decide({ keys: ['demo.storefront-client'], kind: 'service' }, callerScope('api_key'))).toEqual(
        refused,
      );
      expect(
        yield* decide({ keys: ['commerce.storefront-client'], kind: 'service' }, callerScope('api_key', otherCompany)),
      ).toEqual(refused);
    }),
  );

  it.effect('admits a staff member holding the capability and refuses one without it', () =>
    Effect.gen(function* staffMember() {
      expect(yield* decide({ cells: [capability], kind: 'human' }, callerScope('session'))).toEqual({
        codes: ['allow.granted'],
        outcome: 'ALLOWED',
      });
      expect(
        yield* decide({ cells: ['commerce.pricing.price.read-schedule'], kind: 'human' }, callerScope('session')),
      ).toEqual({ codes: ['deny.insufficient_grant'], outcome: 'DENIED' });
      // A binding never admits a person: the workload path is for machines only.
      expect(
        yield* decide({ keys: ['commerce.storefront-client'], kind: 'human' }, callerScope('session')),
      ).toMatchObject({ outcome: 'DENIED' });
    }),
  );
});
