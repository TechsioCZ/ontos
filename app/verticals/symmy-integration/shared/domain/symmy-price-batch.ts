import { DefinePricePayloadSchema } from '@app/pricing/actions/define-price';
import { RevisePricePayloadSchema } from '@app/pricing/actions/revise-price';
import { Schema } from 'effect';

import { SymmyPriceListPriceSchema } from './symmy-price-list-batch.ts';

const define = DefinePricePayloadSchema.fields;
const revise = RevisePricePayloadSchema.members[0].fields;
const [, pricedGroupSelector] = define.identityKey.fields.priceGroupSelector.members;

/** The most items one request may hold: every price is one plan item. */
const SYMMY_PRICE_BATCH_MAX_ITEMS = 16;

/** The reason every Symmy price write states. The caller never supplies it. */
export const SYMMY_PRICE_BATCH_REASON = 'Symmy price import';

/** The Price Group ref of the one price list a request writes to. */
export const SymmyPriceGroupRefSchema = pricedGroupSelector.fields.priceGroupRef;

/** A new Price in the price list of the request. */
const SymmyPriceBatchDefineSchema = Schema.Struct({
  ...SymmyPriceListPriceSchema.fields,
  operation: Schema.Literal('DEFINE'),
});

/** A value-only change of the current revision of an existing Price, fenced by the revision the caller read. */
const SymmyPriceBatchReviseSchema = Schema.Struct({
  amount: revise.monetaryAmount.fields.amount,
  currencyCode: revise.monetaryAmount.fields.currencyCode,
  expectedRevision: Schema.Struct({
    revision: revise.expectedCurrent.fields.revision,
    revisionId: revise.expectedCurrent.fields.revisionId,
  }),
  operation: Schema.Literal('REVISE'),
  priceRef: revise.priceRef,
});
export type SymmyPriceBatchRevise = typeof SymmyPriceBatchReviseSchema.Type;

/** The public price batch as the owner admission receives it: one price list and its DEFINE and REVISE items. */
export const SymmyPriceBatchSchema = Schema.Struct({
  priceGroupRef: SymmyPriceGroupRefSchema,
  prices: Schema.NonEmptyArray(Schema.Union([SymmyPriceBatchDefineSchema, SymmyPriceBatchReviseSchema])).check(
    Schema.isMaxLength(SYMMY_PRICE_BATCH_MAX_ITEMS),
  ),
});
export type SymmyPriceBatch = typeof SymmyPriceBatchSchema.Type;

/**
 * What the Pricing owner already holds about a Price a REVISE item names, read when the request arrives: the
 * schedule position the owner fences on, the unit basis of the price, and the source assertion it was last
 * written with. The caller never sends these, and they are not caller intent.
 */
export const SymmyPriceReviseFactsSchema = Schema.Struct({
  currentSourceAssertionId: define.sourceAssertion.fields.sourceAssertionId,
  effectivePeriod: revise.expectedCurrent.fields.effectivePeriod,
  priceRef: revise.priceRef,
  scheduleRevision: revise.expectedCurrent.fields.scheduleRevision,
  sourceRecordRef: define.sourceAssertion.fields.sourceRecord.fields.sourceRecordRef,
  unitBasis: define.identityKey.fields.unitBasis,
});
export type SymmyPriceReviseFacts = typeof SymmyPriceReviseFactsSchema.Type;

export const SymmyPriceReviseFactsListSchema = Schema.Array(SymmyPriceReviseFactsSchema).check(
  Schema.isMaxLength(SYMMY_PRICE_BATCH_MAX_ITEMS),
);
