import {
  PriceGroupDescriptionSchema,
  PriceGroupCodeSchema,
  PriceGroupInstantSchema,
  PriceGroupNameSchema,
  PriceGroupPurposeSchema,
} from '@app/price-group-catalog-contracts/price-group';
import { SymmyPriceListCodeSchema } from '@app/symmy-integration/symmy-internal-contracts';
import { Schema } from 'effect';

import {
  SymmyPriceCommercialScopeSchema,
  SymmyPriceUnitBasisSchema,
  symmyPriceFields,
} from './price-request-fields.ts';

/**
 * A price in the price list of its item. The price identity needs an exact commercial scope and unit basis, and
 * the route context carries neither a channel, a market nor a unit, so a price without them is refused (400)
 * instead of being given a default.
 */
const SymmyNewPriceSchema = Schema.Struct({
  ...symmyPriceFields,
  commercialScope: SymmyPriceCommercialScopeSchema,
  unitBasis: SymmyPriceUnitBasisSchema,
});

/**
 * A price list is a native Price Group and is only ever created here. There is no end date, type, status,
 * customer group or metadata: the owner has no field for them.
 */
const SymmyPriceListSchema = Schema.Struct({
  businessCode: PriceGroupCodeSchema,
  code: SymmyPriceListCodeSchema,
  description: PriceGroupDescriptionSchema,
  effectiveFrom: PriceGroupInstantSchema,
  name: PriceGroupNameSchema,
  prices: Schema.optionalKey(Schema.Array(SymmyNewPriceSchema)),
  purpose: PriceGroupPurposeSchema,
});

const MAX_PLAN_ITEMS = 16;

/**
 * The public body of `POST /price-lists/batch-upsert`. Each price list and each price is one plan item, and a
 * plan allows sixteen, so the lists and their prices together are limited to sixteen.
 */
export const SymmyPriceListsBatchRequestSchema = Schema.Struct({
  priceLists: Schema.NonEmptyArray(SymmyPriceListSchema),
}).check(
  Schema.makeFilter(({ priceLists }) =>
    priceLists.length + priceLists.reduce((total, { prices }) => total + (prices?.length ?? 0), 0) <= MAX_PLAN_ITEMS
      ? undefined
      : `A request holds at most ${MAX_PLAN_ITEMS} price lists and prices together`,
  ),
);
export type SymmyPriceListsBatchRequest = typeof SymmyPriceListsBatchRequestSchema.Type;
