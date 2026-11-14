import { PriceGroupSourceAssociationSchema } from '@app/price-group-catalog/apis/price-group-source-associations';
import { PriceGroupSourcePricesResponseSchema } from '@app/pricing/apis/price-group-source-prices';
import { PricingInstantSchema } from '@app/pricing-contracts/current-supported-currencies';
import { Schema, Struct } from 'effect';

import { SymmyInternalPriceListsProjectionSchema } from './read-projection-contracts.ts';
import type { SymmyInternalPriceListsProjection } from './read-projection-contracts.ts';

const projectionFields = SymmyInternalPriceListsProjectionSchema.fields;

/**
 * The public body of `GET /price-lists`: camelCase, no internal markers, no qualified id and no nullable field.
 * `priceGroupRef` and the price entries are owner shapes that `POST /price-lists/prices/batch` copies back.
 */
export const SymmyPriceListsResponseSchema = Schema.Struct({
  count: projectionFields.count,
  limit: projectionFields.limit,
  offset: projectionFields.offset,
  priceLists: Schema.Array(
    Schema.Struct({
      code: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(300), Schema.isTrimmed()),
      description: Schema.String,
      endsAt: Schema.optionalKey(PricingInstantSchema),
      name: Schema.String,
      priceGroupRef: PriceGroupSourceAssociationSchema.fields.priceGroupRef,
      prices: Schema.optionalKey(PriceGroupSourcePricesResponseSchema),
      startsAt: PricingInstantSchema,
    }),
  ),
});
type SymmyPriceListsResponse = typeof SymmyPriceListsResponseSchema.Type;

const mapPriceList = (list: SymmyInternalPriceListsProjection['price_lists'][number]) => {
  const base = {
    ...Struct.pick(list, ['description', 'name', 'priceGroupRef', 'prices']),
    code: list.source_record_id,
    startsAt: list.starts_at,
  };
  return list.ends_at === undefined ? base : { ...base, endsAt: list.ends_at };
};

/** `unsupported_fields` is still computed by the projection and is deliberately not exposed. */
export const mapSymmyPriceListsProjection = (
  projection: SymmyInternalPriceListsProjection,
): SymmyPriceListsResponse => ({
  count: projection.count,
  limit: projection.limit,
  offset: projection.offset,
  priceLists: projection.price_lists.map(mapPriceList),
});
