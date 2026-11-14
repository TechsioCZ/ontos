import { ProductRefSchema } from '@app/catalog-selection-contracts/resources/product';
import { ProductUnitRefSchema } from '@app/catalog-selection-contracts/resources/product-unit';
import { VariantRefSchema } from '@app/catalog-selection-contracts/resources/variant';
import { PriceGroupInstantSchema } from '@app/price-group-catalog-contracts/price-group';
import { PricingCurrencyCodeSchema } from '@app/pricing-contracts/domain/currency-support';
import {
  PriceNonNegativeDecimalSchema,
  PricePositiveDecimalSchema,
} from '@app/pricing-contracts/domain/price-definition';
import { PricingChannelIdSchema, PricingMarketIdSchema } from '@app/pricing-contracts/domain/pricing-commercial-scope';
import { Schema } from 'effect';

/**
 * Price fields that two public price routes share. Every field reuses the owner schema, so the limits
 * (nine decimals, recognized ISO 4217 currency, exact market id) cannot drift from what Pricing enforces.
 * The selling legal entity is never in a body: it comes from the route context.
 */
export const symmyPriceFields = {
  amount: PriceNonNegativeDecimalSchema,
  currencyCode: PricingCurrencyCodeSchema,
  /** The owner instant accepts `Z` with or without milliseconds and normalizes to milliseconds. */
  effectiveFrom: PriceGroupInstantSchema,
  productRef: ProductRefSchema,
  variantRef: VariantRefSchema,
} as const;

export const SymmyPriceCommercialScopeSchema = Schema.Struct({
  channelId: PricingChannelIdSchema,
  marketId: PricingMarketIdSchema,
});
export const SymmyPriceUnitBasisSchema = Schema.Struct({
  quantity: PricePositiveDecimalSchema,
  unitRef: ProductUnitRefSchema,
});
