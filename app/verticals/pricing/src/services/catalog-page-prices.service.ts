import { CurrentSupportedCurrenciesSuccessSchema } from '@app/pricing-contracts/current-supported-currencies';
import type { ExactPriceLookupFound } from '@app/pricing-contracts/domain/exact-price-lookup';
import type { ExactPriceResolution } from '@app/pricing-contracts/domain/exact-price-resolution';
import { compareQuantityTierDecimalValues } from '@app/pricing-contracts/domain/quantity-tier';
import { PriceRefSchema } from '@app/pricing-contracts/resources/price';
import { DateTime, Effect, Match, Schema } from 'effect';

import type {
  CatalogPagePrice,
  CatalogPagePriceItem,
  CatalogPagePricesRequest,
} from '../../shared/apis/catalog-page-prices.ts';
import { resolveCurrentSupportedCurrencies } from '../api/current-supported-currencies.read.ts';
import type { CurrencySupportPersistence } from '../persistence/currency-support-persistence.ts';
import type {
  ExactPriceResolutionService,
  ExactPriceResolutionTrustedContext,
} from './exact-price-resolution.service.ts';
import type { QuantityTierPersistence } from './quantity-tier-persistence.service.ts';

/** The owner reads a catalogue page is resolved from, all inside the one scoped transaction of the Read. */
export interface CatalogPagePricesOwnerReads {
  readonly loadCurrencySupport: CurrencySupportPersistence['loadCurrent'];
  readonly readCurrentQuantityTierSet: QuantityTierPersistence['readCurrentSet'];
  /** The one-item exact resolution itself: every variant of the page is resolved by it, never by a copy. */
  readonly resolveExactPrice: ExactPriceResolutionService['resolve'];
}

type CatalogPageQuantityTiers = Extract<CatalogPagePrice, { readonly _tag: 'PRICE_FOUND' }>['quantityTiers'];

const samePriceRef = Schema.toEquivalence(PriceRefSchema);
const tiersUnavailable: CatalogPageQuantityTiers = { _tag: 'QUANTITY_TIERS_UNAVAILABLE', retryable: true };

/** The owner-proven Current Tier set of the used Price, bound to that exact Price, lowest threshold first. */
const quantityTiersOf = (
  readCurrentSet: CatalogPagePricesOwnerReads['readCurrentQuantityTierSet'],
  usedPrice: ExactPriceLookupFound,
): Effect.Effect<CatalogPageQuantityTiers> =>
  readCurrentSet({ effectiveAt: usedPrice.request.effectiveAt, priceRef: usedPrice.priceRef }).pipe(
    Effect.map((outcome): CatalogPageQuantityTiers => {
      if (
        outcome.outcome !== 'QUANTITY_TIER_SET_CURRENT' ||
        !samePriceRef(outcome.tierSet.priceRef, usedPrice.priceRef) ||
        !outcome.tierSet.currentTiers.every(({ definition }) =>
          samePriceRef(definition.identityKey.priceRef, usedPrice.priceRef),
        )
      ) {
        return tiersUnavailable;
      }
      return {
        _tag: 'QUANTITY_TIERS_CURRENT',
        tiers: outcome.tierSet.currentTiers
          .map(({ definition }) => ({
            monetaryBoundary: definition.revision.monetaryBoundary,
            thresholdQuantity: definition.identityKey.thresholdQuantity,
            unitPrice: definition.revision.resultingUnitPrice,
          }))
          .toSorted((left, right) => compareQuantityTierDecimalValues(left.thresholdQuantity, right.thresholdQuantity)),
      };
    }),
    Effect.catchTag('QuantityTierPersistenceUnavailable', () => Effect.succeed(tiersUnavailable)),
  );

/**
 * The public outcome of one variant, read from the exact resolution's own path. Owner evidence, conflict claimants
 * and absence proofs stay private; a variant with no applicable Price is reported as such, never priced.
 */
const catalogPagePriceOf = (
  item: CatalogPagePriceItem,
  resolution: ExactPriceResolution,
  readCurrentSet: CatalogPagePricesOwnerReads['readCurrentQuantityTierSet'],
): Effect.Effect<CatalogPagePrice> => {
  const found = ({ usedPrice }: { readonly usedPrice: ExactPriceLookupFound }) =>
    quantityTiersOf(readCurrentSet, usedPrice).pipe(
      Effect.map((quantityTiers): CatalogPagePrice => ({
        _tag: 'PRICE_FOUND',
        catalogSelection: item.catalogSelection,
        channelId: usedPrice.request.exactKey.commercialScope.channelId,
        priceGroupSelector: usedPrice.request.exactKey.priceGroupSelector,
        priceRef: usedPrice.priceRef,
        priceRevision: usedPrice.priceRevision,
        quantityTiers,
        unitBasis: item.unitBasis,
      })),
    );
  return Match.value(resolution.path).pipe(
    Match.tag('GROUP_PRICE', found),
    Match.tag('NO_GROUP_AFTER_PROVEN_GROUP_ABSENCE', found),
    Match.tag('NO_GROUP_GUEST', found),
    Match.tag('NO_GROUP_NONE', found),
    Match.tag('NO_APPLICABLE_PRICE', () =>
      Effect.succeed<CatalogPagePrice>({ _tag: 'NO_APPLICABLE_PRICE', ...item, retryable: false }),
    ),
    Match.tag('CONFLICT', ({ reason }) =>
      Effect.succeed<CatalogPagePrice>({ _tag: 'PRICING_CONFLICT', ...item, reason, retryable: false }),
    ),
    Match.tag('CONFIGURATION_ERROR', ({ reason }) =>
      Effect.succeed<CatalogPagePrice>({ _tag: 'PRICING_CONFIGURATION_ERROR', ...item, reason, retryable: false }),
    ),
    Match.tag('INDETERMINATE', ({ reason }) =>
      Effect.succeed<CatalogPagePrice>({ _tag: 'PRICING_INDETERMINATE', ...item, reason, retryable: true }),
    ),
    Match.exhaustive,
  );
};

/**
 * Prices a catalogue page for an anonymous visitor in the owner's own terms: each variant is the Guest input of
 * the exact Price resolution (the exact no-group Price key of its Channel, Market, currency and Unit basis) at
 * the trusted instant, with the same Current Tenant Currency Support proof the whole-candidate decision uses.
 */
export const readCatalogPagePrices = Effect.fn('CatalogPagePrices.read')(function* read(
  request: CatalogPagePricesRequest,
  trusted: ExactPriceResolutionTrustedContext,
  owner: CatalogPagePricesOwnerReads,
) {
  const effectiveAt = DateTime.formatIso(trusted.trustedOperationAt);
  const currencySupport = yield* resolveCurrentSupportedCurrencies(
    { effectiveAt, tenantId: trusted.tenantId },
    { tenantId: trusted.tenantId },
    owner.loadCurrencySupport,
  );
  if (!Schema.is(CurrentSupportedCurrenciesSuccessSchema)(currencySupport)) {
    return { _tag: 'CURRENCY_SUPPORT_NOT_CURRENT' as const, currencySupport, effectiveAt };
  }
  const prices = yield* Effect.forEach(
    request.items,
    (item) =>
      owner
        .resolveExactPrice(
          {
            currencySupport,
            resolutionInput: {
              _tag: 'GUEST',
              basis: {
                catalogSelection: item.catalogSelection,
                commercialScope: {
                  channelId: request.channelId,
                  marketId: request.marketId,
                  sellingLegalEntityId: trusted.legalEntityId,
                },
                currencyCode: request.currencyCode,
                unitBasis: item.unitBasis,
              },
              effectiveAt,
            },
          },
          trusted,
        )
        .pipe(Effect.flatMap((resolution) => catalogPagePriceOf(item, resolution, owner.readCurrentQuantityTierSet))),
    // Every variant is read through the one owner transaction of this Read, one statement after another.
    { concurrency: 1 },
  );
  return { _tag: 'CATALOG_PAGE_PRICED' as const, effectiveAt, prices };
});
