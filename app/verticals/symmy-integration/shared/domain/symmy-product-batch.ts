import { SetVariantLocalizedFactsPayloadSchema } from '@app/catalog/api/set-variant-localized-facts-action';
import { ProductDescriptionSchema, ProductNameSchema } from '@app/catalog/domain/product';
import { DefinePricePayloadSchema } from '@app/pricing/actions/define-price';
import { Schema } from 'effect';

import { SymmyPriceGroupRefSchema } from './symmy-price-batch.ts';

const price = DefinePricePayloadSchema.fields;
const identity = price.identityKey.fields;
const localized = SetVariantLocalizedFactsPayloadSchema.fields;

/** A plan holds at most sixteen items and an item at most thirty-two effects. */
const SYMMY_PRODUCT_BATCH_MAX_ITEMS = 16;
const SYMMY_PRODUCT_MAX_EFFECTS = 32;

/** The reason and the evidence stem every Symmy product write states. The caller never supplies them. */
export const SYMMY_PRODUCT_REASON = 'Symmy product import';

/**
 * The public product fields no Symmy intent can write. Each one is reported as an unsupported branch of the
 * product item instead of being dropped; one kind stands for every field of its group.
 */
export const SymmyProductHintKindSchema = Schema.Literals([
  'CategoryHint',
  'AttributeHint',
  'MediaHint',
  'VariantUpdateHint',
  'DescriptiveHint',
  'ClassificationHint',
]);
export type SymmyProductHintKind = typeof SymmyProductHintKindSchema.Type;

const ProductLifecycleSchema = Schema.Literals(['DRAFT', 'ACTIVE', 'RETIRED']);
const identifierValue = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(300));

const SymmyProductLocalizedSchema = Schema.Struct({
  description: localized.facts.fields.description,
  locale: localized.locale,
  name: localized.facts.fields.name,
}).check(
  Schema.makeFilter(
    ({ description, name }) => description !== undefined || name !== undefined || 'A localized text needs a value',
  ),
);

/** A price of a variant. Whatever the body leaves out, the route enrollment supplies or the price is reported. */
const SymmyProductPriceSchema = Schema.Struct({
  amount: price.monetaryAmount.fields.amount,
  commercialScope: Schema.optionalKey(
    Schema.Struct({
      channelId: Schema.optionalKey(identity.commercialScope.fields.channelId),
      marketId: Schema.optionalKey(identity.commercialScope.fields.marketId),
      sellingLegalEntityId: Schema.optionalKey(identity.commercialScope.fields.sellingLegalEntityId),
    }),
  ),
  currencyCode: price.monetaryAmount.fields.currencyCode,
  effectiveFrom: Schema.optionalKey(price.effectiveFrom),
  priceGroupCode: Schema.optionalKey(identifierValue),
  unitBasis: Schema.optionalKey(identity.unitBasis),
});

const SymmyProductVariantSchema = Schema.Struct({
  identifier: Schema.optionalKey(
    Schema.Struct({ type: Schema.Literals(['sku', 'ean', 'variantId']), value: identifierValue }),
  ),
  localized: Schema.Array(SymmyProductLocalizedSchema),
  prices: Schema.Array(SymmyProductPriceSchema),
});

/**
 * One public product as the owner admission receives it, with every field no intent can write already named in
 * `unsupported`. The first variant is the initial variant, created together with the product.
 */
export const SymmyProductRowSchema = Schema.Struct({
  description: Schema.optionalKey(ProductDescriptionSchema),
  identifier: Schema.optionalKey(
    Schema.Struct({ type: Schema.Literals(['sku', 'ean', 'erpId']), value: identifierValue }),
  ),
  lifecycle: Schema.optionalKey(ProductLifecycleSchema),
  name: ProductNameSchema,
  unsupported: Schema.Array(SymmyProductHintKindSchema).check(
    Schema.makeFilter(
      (kinds) => new Set(kinds).size === kinds.length || 'A product names each unsupported group at most once',
    ),
  ),
  variants: Schema.NonEmptyArray(SymmyProductVariantSchema),
});
export type SymmyProductRow = typeof SymmyProductRowSchema.Type;

interface SizedProduct {
  readonly lifecycle?: 'DRAFT' | 'ACTIVE' | 'RETIRED' | undefined;
  readonly variants: readonly {
    readonly localized?: readonly unknown[] | undefined;
    readonly prices?: readonly unknown[] | undefined;
  }[];
}

/**
 * What a product needs in a plan: a create (and an update for a lifecycle other than the created DRAFT), one
 * create per further variant, one text effect per localized text and one define per price. A source record
 * belongs to one item, so the product, each variant that has its own effects and each price is an item.
 */
export const symmyProductPlanSize = ({ lifecycle, variants }: SizedProduct) => {
  const texts = variants.reduce((total, variant) => total + (variant.localized?.length ?? 0), 0);
  const prices = variants.reduce((total, variant) => total + (variant.prices?.length ?? 0), 0);
  const variantItems = variants.filter((variant, index) => index > 0 || (variant.localized?.length ?? 0) > 0).length;
  return {
    effects: 1 + (lifecycle === 'ACTIVE' || lifecycle === 'RETIRED' ? 1 : 0) + (variants.length - 1) + texts + prices,
    items: 1 + variantItems + prices,
  };
};

/** Why a request cannot be planned, or undefined when it fits one plan. */
export const symmyProductBatchLimit = (products: readonly SizedProduct[]): string | undefined => {
  const sizes = products.map(symmyProductPlanSize);
  if (sizes.some(({ effects }) => effects > SYMMY_PRODUCT_MAX_EFFECTS)) {
    return `A product needs at most ${SYMMY_PRODUCT_MAX_EFFECTS} owner effects`;
  }
  return sizes.reduce((total, { items }) => total + items, 0) > SYMMY_PRODUCT_BATCH_MAX_ITEMS
    ? `A request needs at most ${SYMMY_PRODUCT_BATCH_MAX_ITEMS} plan items: its products, their variants with effects of their own and their prices`
    : undefined;
};

/**
 * The sizes of public products, whatever their other fields: the plan limit a request body is checked against
 * before it is mapped, so a request no plan can hold is refused at the decoder.
 */
export const SymmyProductPlanSizeSchema = Schema.Array(
  Schema.Struct({
    lifecycle: Schema.optionalKey(ProductLifecycleSchema),
    variants: Schema.Array(
      Schema.Struct({
        localized: Schema.optionalKey(Schema.Array(Schema.Unknown)),
        prices: Schema.optionalKey(Schema.Array(Schema.Unknown)),
      }),
    ),
  }),
).check(Schema.makeFilter((products) => symmyProductBatchLimit(products)));

export const SymmyProductRowsSchema = Schema.NonEmptyArray(SymmyProductRowSchema).check(
  Schema.makeFilter((products) => symmyProductBatchLimit(products)),
);
export type SymmyProductRows = typeof SymmyProductRowsSchema.Type;

/**
 * The price list each named price group code resolves to, read when the request arrives from the lists this
 * route's own source created. It is a fact of the route, never caller intent.
 */
export const SymmyProductPriceGroupFactsSchema = Schema.Array(
  Schema.Struct({ code: identifierValue, priceGroupRef: SymmyPriceGroupRefSchema }),
).check(Schema.isMaxLength(SYMMY_PRODUCT_BATCH_MAX_ITEMS));
export type SymmyProductPriceGroupFacts = typeof SymmyProductPriceGroupFactsSchema.Type;
