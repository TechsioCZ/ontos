import { PriceGroupRefSchema } from '@app/price-group-catalog-contracts/resources/price-group';
import { PriceRevisionIdSchema, PriceRevisionNumberSchema } from '@app/pricing-contracts/domain/price-definition';
import { PriceRefSchema } from '@app/pricing-contracts/resources/price';
import { Schema } from 'effect';

import {
  SymmyPriceCommercialScopeSchema,
  SymmyPriceUnitBasisSchema,
  symmyPriceFields,
} from './price-request-fields.ts';

/** A new Price. `commercialScope` and `unitBasis` are required, and the price list is the request's. */
const DefinePriceSchema = Schema.Struct({
  amount: symmyPriceFields.amount,
  commercialScope: SymmyPriceCommercialScopeSchema,
  currencyCode: symmyPriceFields.currencyCode,
  effectiveFrom: symmyPriceFields.effectiveFrom,
  operation: Schema.Literal('DEFINE'),
  productRef: symmyPriceFields.productRef,
  unitBasis: SymmyPriceUnitBasisSchema,
  variantRef: symmyPriceFields.variantRef,
});

/** A value-only change of the current revision, fenced by the revision the caller last read. */
const RevisePriceSchema = Schema.Struct({
  amount: symmyPriceFields.amount,
  currencyCode: symmyPriceFields.currencyCode,
  expectedRevision: Schema.Struct({ revision: PriceRevisionNumberSchema, revisionId: PriceRevisionIdSchema }),
  operation: Schema.Literal('REVISE'),
  priceRef: PriceRefSchema,
});

const trimTrailingZeros = (quantity: string) =>
  quantity.includes('.') ? quantity.replace(/0+$/u, '').replace(/\.$/u, '') : quantity;

type PriceItem = typeof DefinePriceSchema.Type | typeof RevisePriceSchema.Type;
/** The identity a price is written under, so two items for one price are one error rather than a race. */
const identityOf = (item: PriceItem): string =>
  item.operation === 'REVISE'
    ? `REVISE:${item.priceRef.resourceId}`
    : [
        'DEFINE',
        item.variantRef.resourceId,
        item.currencyCode,
        item.commercialScope.channelId,
        item.commercialScope.marketId,
        trimTrailingZeros(item.unitBasis.quantity),
        item.unitBasis.unitRef.resourceId,
      ].join(':');

/** The public body of `POST /price-lists/prices/batch`: one price list per request, one to sixteen items. */
export const SymmyPriceListPricesBatchRequestSchema = Schema.Struct({
  priceGroupRef: PriceGroupRefSchema,
  prices: Schema.NonEmptyArray(Schema.Union([DefinePriceSchema, RevisePriceSchema])).check(
    Schema.isMaxLength(16),
    Schema.makeFilter((items) =>
      new Set(items.map(identityOf)).size === items.length ? undefined : 'Two items write the same price',
    ),
  ),
});
export type SymmyPriceListPricesBatchRequest = typeof SymmyPriceListPricesBatchRequestSchema.Type;
