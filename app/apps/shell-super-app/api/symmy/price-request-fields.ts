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

import { symmyOwnerRef } from './owner-ref.ts';

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
  productId: ProductRefSchema.fields.resourceId,
  variantId: VariantRefSchema.fields.resourceId,
} as const;

export const SymmyPriceCommercialScopeSchema = Schema.Struct({
  channelId: PricingChannelIdSchema,
  marketId: PricingMarketIdSchema,
});
export const SymmyPriceUnitBasisSchema = Schema.Struct({
  quantity: PricePositiveDecimalSchema,
  unitId: ProductUnitRefSchema.fields.resourceId,
});

/** The owner unit basis, with the unit reference built for the tenant of the admitted route. */
export const symmyOwnerUnitBasis = ({ quantity, unitId }: typeof SymmyPriceUnitBasisSchema.Type, tenantId: string) => ({
  quantity,
  unitRef: symmyOwnerRef(ProductUnitRefSchema, tenantId, unitId),
});

/** One new price as the owner receives it: each id replaced by its reference of the admitted route's tenant. */
export const symmyOwnerPrice = <
  Price extends {
    readonly productId: string;
    readonly unitBasis: typeof SymmyPriceUnitBasisSchema.Type;
    readonly variantId: string;
  },
>(
  { productId, unitBasis, variantId, ...price }: Price,
  tenantId: string,
) => ({
  ...price,
  productRef: symmyOwnerRef(ProductRefSchema, tenantId, productId),
  unitBasis: symmyOwnerUnitBasis(unitBasis, tenantId),
  variantRef: symmyOwnerRef(VariantRefSchema, tenantId, variantId),
});
