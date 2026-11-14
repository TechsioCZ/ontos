import {
  PriceGroupDescriptionSchema,
  PriceGroupCodeSchema,
  PriceGroupInstantSchema,
  PriceGroupNameSchema,
  PriceGroupPurposeSchema,
} from '@app/price-group-catalog-contracts/price-group';
import { Schema } from 'effect';

import {
  SymmyPriceCommercialScopeSchema,
  SymmyPriceUnitBasisSchema,
  symmyPriceFields,
} from './price-request-fields.ts';

/** Symmy's own key for the price list. It becomes the source record id and is not the owner's business code. */
const SymmyPriceListCodeSchema = Schema.String.check(Schema.isPattern(/^[a-zA-Z0-9._-]{1,80}$/u)).pipe(
  Schema.brand('SymmyPriceListCode'),
);

/** A price in the price list of its item. `commercialScope` and `unitBasis` are optional on this route. */
const SymmyNewPriceSchema = Schema.Struct({
  ...symmyPriceFields,
  commercialScope: Schema.optionalKey(SymmyPriceCommercialScopeSchema),
  unitBasis: Schema.optionalKey(SymmyPriceUnitBasisSchema),
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
