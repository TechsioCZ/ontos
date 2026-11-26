import type { CatalogSelection } from '@app/catalog-selection-contracts/catalog-selection';
import { PricingCurrencyCodeSchema, PricingInstantSchema } from '../apis/current-supported-currencies.ts';
import { PriceIdentityKeySchema, PriceNonNegativeDecimalSchema } from '../domain/price-definition.ts';
import {
  PriceSourceAssertionAssessmentSchema,
  PriceSourceAssertionInputSchema,
} from '../domain/price-source-provenance.ts';
import { PriceRefSchema } from '../resources/price.ts';
import { Schema } from 'effect';

const boundedReason = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(1000), Schema.isTrimmed());
const MonetaryAmountSchema = Schema.Struct({
  amount: PriceNonNegativeDecimalSchema,
  currencyCode: PricingCurrencyCodeSchema,
});

export const DefinePricePayloadSchema = Schema.Struct({
  effectiveFrom: PricingInstantSchema,
  identityKey: PriceIdentityKeySchema,
  monetaryAmount: MonetaryAmountSchema,
  priceRef: PriceRefSchema,
  reason: boundedReason,
  sourceAssertion: PriceSourceAssertionInputSchema,
}).check(
  Schema.makeFilter(({ identityKey, monetaryAmount, priceRef }) => {
    const selection: CatalogSelection = identityKey.catalogSelection;
    if (priceRef.tenantId !== selection.productRef.tenantId) {
      return 'Price and Catalog Selection must belong to the same Tenant';
    }
    return monetaryAmount.currencyCode === identityKey.currencyCode
      ? undefined
      : 'Price amount currency must equal the stable Price key currency';
  }),
);
export type DefinePricePayload = typeof DefinePricePayloadSchema.Type;

export const DefinePriceResultSchema = PriceSourceAssertionAssessmentSchema;
export type DefinePriceResult = typeof DefinePriceResultSchema.Type;
