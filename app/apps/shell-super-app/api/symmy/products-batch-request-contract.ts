import { SetVariantLocalizedFactsPayloadSchema } from '@app/catalog/api/set-variant-localized-facts-action';
import { ProductDescriptionSchema, ProductNameSchema } from '@app/catalog/domain/product';
import { AttributeDefinitionRefSchema } from '@app/catalog/resources/attribute-definition';
import { BrandRefSchema } from '@app/catalog/resources/brand';
import { ControlledAttributeValueRefSchema } from '@app/catalog/resources/controlled-attribute-value';
import { ProductCategoryRefSchema } from '@app/catalog/resources/product-category';
import { ProductTypeRefSchema } from '@app/catalog/resources/product-type';
import { ProductRefSchema } from '@app/catalog-selection-contracts/resources/product';
import { VariantRefSchema } from '@app/catalog-selection-contracts/resources/variant';
import { MarketRefSchema } from '@app/commerce-market-catalog/resources/market';
import { LegalEntityRefSchema } from '@app/core-runtime/resources/legal-entity';
import { PartyRefSchema } from '@app/party-registry/resources/party';
import { PricingCurrencyCodeSchema } from '@app/pricing-contracts/domain/currency-support';
import { PricingChannelIdSchema } from '@app/pricing-contracts/domain/pricing-commercial-scope';
import { PriceNonNegativeDecimalSchema } from '@app/pricing-contracts/domain/price-definition';
import { SymmyProductPlanSizeSchema } from '@app/symmy-integration/symmy-internal-contracts';
import { Schema } from 'effect';

import { SymmyPriceUnitBasisSchema } from './price-request-fields.ts';

const text = (maximum: number) => Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(maximum));
const instant = Schema.DateTimeUtcFromString;

const localizedFacts = SetVariantLocalizedFactsPayloadSchema.fields;
const EffectivePeriodSchema = Schema.Struct({
  effectiveFrom: Schema.optionalKey(instant),
  effectiveTo: Schema.optionalKey(instant),
});
const GtinSchema = Schema.Struct({ code: text(64), effectiveAt: instant });
/** The texts and the locale are the owner's own, so what Catalog cannot store is refused here with 400. */
const LocalizedSchema = Schema.Struct({
  description: localizedFacts.facts.fields.description,
  locale: localizedFacts.locale,
  name: localizedFacts.facts.fields.name,
});

const AttributeValueSchema = Schema.Union([
  Schema.Struct({ kind: Schema.Literal('TEXT'), text: Schema.String }),
  Schema.Struct({ kind: Schema.Literal('CONTROLLED'), valueId: ControlledAttributeValueRefSchema.fields.resourceId }),
  Schema.Struct({ amount: Schema.Finite, kind: Schema.Literal('MEASUREMENT'), unit: text(300) }),
  Schema.Struct({ kind: Schema.Literal('SPECIAL'), state: Schema.Literals(['UNKNOWN', 'NONE', 'NOT_APPLICABLE']) }),
]);
const AttributeSchema = Schema.Struct({
  attributeDefinitionId: AttributeDefinitionRefSchema.fields.resourceId,
  values: Schema.optionalKey(Schema.Array(AttributeValueSchema)),
});

/** `brandId` exists only for kind `brand`. */
const BrandSchema = Schema.Union([
  Schema.Struct({ brandId: BrandRefSchema.fields.resourceId, kind: Schema.Literal('brand') }),
  Schema.Struct({ kind: Schema.Literals(['unknown', 'confirmed_unbranded']) }),
]);
const ManufacturerSchema = Schema.Struct({
  effectivePeriod: Schema.optionalKey(EffectivePeriodSchema),
  target: Schema.Union([
    Schema.Struct({ kind: Schema.Literal('PARTY'), partyId: PartyRefSchema.fields.resourceId }),
    Schema.Struct({ kind: Schema.Literal('LEGAL_ENTITY'), legalEntityId: LegalEntityRefSchema.fields.resourceId }),
  ]),
});
const MediaSchema = Schema.Struct({
  order: Schema.Finite,
  purpose: text(300),
  resourceId: text(300),
  resourceKind: Schema.Literals(['MEDIA', 'DOCUMENT']),
});
const RelationshipSchema = Schema.Struct({
  effectivePeriod: Schema.optionalKey(EffectivePeriodSchema),
  /** Exactly one of the two ids: naming both, or neither, matches no member. */
  target: Schema.Union([
    Schema.Struct({ productId: ProductRefSchema.fields.resourceId }),
    Schema.Struct({ variantId: VariantRefSchema.fields.resourceId }),
  ]),
  type: Schema.Literals(['ACCESSORY_FOR', 'RELATED_PRODUCT', 'SUCCESSOR']),
});

/** A price exists only on a variant. Without a price group code it is the base price. */
const PriceSchema = Schema.Struct({
  amount: PriceNonNegativeDecimalSchema,
  commercialScope: Schema.optionalKey(
    Schema.Struct({
      channelId: Schema.optionalKey(PricingChannelIdSchema),
      marketId: Schema.optionalKey(MarketRefSchema.fields.resourceId),
      sellingLegalEntityId: Schema.optionalKey(LegalEntityRefSchema.fields.resourceId),
    }),
  ),
  currencyCode: PricingCurrencyCodeSchema,
  effectiveFrom: Schema.optionalKey(instant),
  priceGroupCode: Schema.optionalKey(text(300)),
  unitBasis: Schema.optionalKey(SymmyPriceUnitBasisSchema),
});

const VariantSchema = Schema.Struct({
  attributes: Schema.optionalKey(Schema.Array(AttributeSchema)),
  gtin: Schema.optionalKey(GtinSchema),
  identifier: Schema.optionalKey(
    Schema.Struct({ type: Schema.Literals(['sku', 'ean', 'variantId']), value: text(300) }),
  ),
  lifecycle: Schema.optionalKey(Schema.Literals(['WORK_IN_PROGRESS', 'ACTIVE', 'RETIRED'])),
  localized: Schema.optionalKey(Schema.Array(LocalizedSchema)),
  prices: Schema.optionalKey(Schema.Array(PriceSchema)),
  sku: Schema.optionalKey(text(300)),
});

const SymmyProductSchema = Schema.Struct({
  attributes: Schema.optionalKey(Schema.Array(AttributeSchema)),
  brand: Schema.optionalKey(BrandSchema),
  categoryIds: Schema.optionalKey(Schema.Array(ProductCategoryRefSchema.fields.resourceId)),
  description: Schema.optionalKey(ProductDescriptionSchema),
  gtin: Schema.optionalKey(GtinSchema),
  identifier: Schema.optionalKey(Schema.Struct({ type: Schema.Literals(['sku', 'ean', 'erpId']), value: text(300) })),
  lifecycle: Schema.optionalKey(Schema.Literals(['DRAFT', 'ACTIVE', 'RETIRED'])),
  localized: Schema.optionalKey(Schema.Array(LocalizedSchema)),
  manufacturer: Schema.optionalKey(ManufacturerSchema),
  media: Schema.optionalKey(Schema.Array(MediaSchema)),
  name: ProductNameSchema,
  productTypeId: Schema.optionalKey(ProductTypeRefSchema.fields.resourceId),
  relationships: Schema.optionalKey(Schema.Array(RelationshipSchema)),
  sizeIds: Schema.optionalKey(Schema.Array(text(300))),
  sku: Schema.optionalKey(text(300)),
  /** The first variant is the initial variant, created together with the product. */
  variants: Schema.NonEmptyArray(VariantSchema),
});

/** The plan size counts what the admission receives, where the sent category ids are the categories. */
const asPlanSizeInput = (products: readonly (typeof SymmyProductSchema.Type)[]) =>
  products.map(({ categoryIds, ...product }) =>
    categoryIds === undefined ? product : { ...product, categories: categoryIds },
  );

/**
 * The public body of `POST /products/batch`: one to sixteen products, each with at least one variant.
 * There is no product-level price and no version field. A plan holds sixteen items of at most thirty-two
 * effects, so a request whose products need more than that is refused (400).
 */
export const SymmyProductsBatchRequestSchema = Schema.Struct({
  products: Schema.NonEmptyArray(SymmyProductSchema).check(
    Schema.isMaxLength(16),
    Schema.makeFilter(
      (products) =>
        Schema.is(SymmyProductPlanSizeSchema)(asPlanSizeInput(products)) || 'A request needs more than one plan holds',
    ),
  ),
});
export type SymmyProductsBatchRequest = typeof SymmyProductsBatchRequestSchema.Type;
