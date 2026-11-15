import { CreatePriceGroupPayloadSchema } from '@app/price-group-catalog/actions/create-price-group';
import { PriceGroupCatalogHeadResponseSchema } from '@app/price-group-catalog/apis/price-group-catalog-head';
import { DefinePricePayloadSchema } from '@app/pricing/actions/define-price';
import { Schema } from 'effect';

const group = CreatePriceGroupPayloadSchema.fields;
const price = DefinePricePayloadSchema.fields;
const identity = price.identityKey.fields;

/** The most plan items one request may hold: every price list and every price is one item. */
const SYMMY_PRICE_LIST_BATCH_MAX_ITEMS = 16;

/** Symmy's own key for a price list. It becomes the source record id and is not the owner's business code. */
export const SymmyPriceListCodeSchema = Schema.String.check(Schema.isPattern(/^[a-zA-Z0-9._-]{1,80}$/u)).pipe(
  Schema.brand('SymmyPriceListCode'),
);

/** One price of a price list created by the same request. The price scope and unit basis are explicit. */
export const SymmyPriceListPriceSchema = Schema.Struct({
  amount: price.monetaryAmount.fields.amount,
  commercialScope: Schema.Struct({
    channelId: identity.commercialScope.fields.channelId,
    marketId: identity.commercialScope.fields.marketId,
  }),
  currencyCode: price.monetaryAmount.fields.currencyCode,
  effectiveFrom: price.effectiveFrom,
  productRef: identity.catalogSelection.fields.productRef,
  unitBasis: identity.unitBasis,
  variantRef: identity.catalogSelection.fields.variantRef,
});
export type SymmyPriceListPrice = typeof SymmyPriceListPriceSchema.Type;

/** One public price list with its prices. There is no end date, type, status, customer group or metadata. */
export const SymmyPriceListRowSchema = Schema.Struct({
  businessCode: group.businessCode,
  code: SymmyPriceListCodeSchema,
  description: group.description,
  effectiveFrom: group.effectiveFrom,
  name: group.displayName,
  prices: Schema.optionalKey(Schema.Array(SymmyPriceListPriceSchema)),
  purpose: group.classificationPurpose,
});
export type SymmyPriceListRow = typeof SymmyPriceListRowSchema.Type;

/** The lists and their prices together are at most one plan: sixteen items. */
const symmyPriceListBatchItemCount = (rows: readonly Pick<SymmyPriceListRow, 'prices'>[]): number =>
  rows.length + rows.reduce((total, { prices }) => total + (prices?.length ?? 0), 0);

export const SymmyPriceListRowsSchema = Schema.NonEmptyArray(SymmyPriceListRowSchema).check(
  Schema.makeFilter(
    (rows) =>
      symmyPriceListBatchItemCount(rows) <= SYMMY_PRICE_LIST_BATCH_MAX_ITEMS ||
      `A request holds at most ${SYMMY_PRICE_LIST_BATCH_MAX_ITEMS} price lists and prices together`,
  ),
);
export type SymmyPriceListRows = typeof SymmyPriceListRowsSchema.Type;

/** The tenant catalog head read when the request arrives: the exact fence of the first created price list. */
export const SymmyCatalogHeadSchema = PriceGroupCatalogHeadResponseSchema.fields.catalogRevision;

/** Compatibility the Symmy price lists declare. Nothing in Pricing names a production contract yet. */
export const SYMMY_PRICE_GROUP_COMPATIBILITY_CONTRACTS = [
  { contractId: 'internal.c14-price-group', version: 1 },
] as const;
export const SYMMY_PRICE_LIST_REASON = 'Symmy price list import';
export const SYMMY_PRICE_REASON = 'Symmy price import';

/** What the route enrolls to define prices: the grant refs a price assertion must name. */
export const SymmyPriceSourceSchema = Schema.Struct({
  mapping: price.sourceAssertion.fields.mapping,
  sourceAuthority: price.sourceAssertion.fields.sourceAuthority,
});
