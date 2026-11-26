import { PriceGroupSourceAssociationSchema } from '@app/price-group-catalog/apis/price-group-source-associations';
import { PricingInstantSchema } from '@app/pricing-contracts/current-supported-currencies';
import { Schema, Struct } from 'effect';

import { SymmyInternalPriceListsProjectionSchema } from './read-projection-contracts.ts';
import type { SymmyInternalPriceListsProjection } from './read-projection-contracts.ts';
import { mapSymmySourcePrices, SymmySourcePricesSchema } from './source-prices-public-contract.ts';

const projectionFields = SymmyInternalPriceListsProjectionSchema.fields;

/**
 * The public body of `GET /price-lists`: camelCase, no internal markers, no qualified id and no nullable field.
 * Every reference is a plain id: `priceGroupId` and the ids of the price entries are the ones
 * `POST /price-lists/prices/batch` takes back.
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
      priceGroupId: PriceGroupSourceAssociationSchema.fields.priceGroupRef.fields.resourceId,
      prices: Schema.optionalKey(SymmySourcePricesSchema),
      startsAt: PricingInstantSchema,
    }),
  ),
});
type SymmyPriceListsResponse = typeof SymmyPriceListsResponseSchema.Type;

const mapPriceList = (list: SymmyInternalPriceListsProjection['price_lists'][number]) => {
  const base = {
    ...Struct.pick(list, ['description', 'name']),
    code: list.source_record_id,
    priceGroupId: list.priceGroupRef.resourceId,
    startsAt: list.starts_at,
  };
  const priced = list.prices === undefined ? base : { ...base, prices: mapSymmySourcePrices(list.prices) };
  return list.ends_at === undefined ? priced : { ...priced, endsAt: list.ends_at };
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
