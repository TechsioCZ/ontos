import { AttributeDefinitionRefSchema } from '@app/catalog/resources/attribute-definition';
import { BrandRefSchema } from '@app/catalog/resources/brand';
import { ControlledAttributeValueRefSchema } from '@app/catalog/resources/controlled-attribute-value';
import { ProductCategoryRefSchema } from '@app/catalog/resources/product-category';
import { ProductTypeRefSchema } from '@app/catalog/resources/product-type';
import { ProductRefSchema } from '@app/catalog-selection-contracts/resources/product';
import { ProductUnitRefSchema } from '@app/catalog-selection-contracts/resources/product-unit';
import { VariantRefSchema } from '@app/catalog-selection-contracts/resources/variant';
import { MarketRefSchema } from '@app/commerce-market-catalog/resources/market';
import { LegalEntityRefSchema } from '@app/core-runtime/resources/legal-entity';
import { PartyRefSchema } from '@app/party-registry/resources/party';
import { PricingCurrencyCodeSchema } from '@app/pricing-contracts/domain/currency-support';
import {
  PriceNonNegativeDecimalSchema,
  PricePositiveDecimalSchema,
} from '@app/pricing-contracts/domain/price-definition';
import { Schema } from 'effect';

const text = (maximum: number) => Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(maximum));
const instant = Schema.DateTimeUtcFromString;

/**
 * An owner reference object whose owner schema is not exported: sizes, media documents and the price channel.
 * It keeps the shape every owner reference has, so a bare string is refused. The owner names the exact type later.
 */
const SymmyOwnerRefSchema = Schema.Struct({
  moduleId: text(300),
  resourceId: text(300),
  resourceType: text(300),
  tenantId: Schema.String.check(Schema.isUUID()).pipe(Schema.brand('SymmyOwnerRefTenantId')),
});

const EffectivePeriodSchema = Schema.Struct({
  effectiveFrom: Schema.optionalKey(instant),
  effectiveTo: Schema.optionalKey(instant),
});
const GtinSchema = Schema.Struct({ code: text(64), effectiveAt: instant });
const LocalizedSchema = Schema.Struct({
  description: Schema.optionalKey(text(4000)),
  locale: text(100),
  name: Schema.optionalKey(text(240)),
});

const AttributeValueSchema = Schema.Union([
  Schema.Struct({ kind: Schema.Literal('TEXT'), text: Schema.String }),
  Schema.Struct({ kind: Schema.Literal('CONTROLLED'), valueRef: ControlledAttributeValueRefSchema }),
  Schema.Struct({ amount: Schema.Finite, kind: Schema.Literal('MEASUREMENT'), unit: text(300) }),
  Schema.Struct({ kind: Schema.Literal('SPECIAL'), state: Schema.Literals(['UNKNOWN', 'NONE', 'NOT_APPLICABLE']) }),
]);
const AttributeSchema = Schema.Struct({
  attributeDefinitionRef: AttributeDefinitionRefSchema,
  values: Schema.optionalKey(Schema.Array(AttributeValueSchema)),
});

/** `brandRef` exists only for kind `brand`. */
const BrandSchema = Schema.Union([
  Schema.Struct({ brandRef: BrandRefSchema, kind: Schema.Literal('brand') }),
  Schema.Struct({ kind: Schema.Literals(['unknown', 'confirmed_unbranded']) }),
]);
const ManufacturerSchema = Schema.Struct({
  effectivePeriod: Schema.optionalKey(EffectivePeriodSchema),
  target: Schema.Union([
    Schema.Struct({ kind: Schema.Literal('PARTY'), partyRef: PartyRefSchema }),
    Schema.Struct({ kind: Schema.Literal('LEGAL_ENTITY'), legalEntityRef: LegalEntityRefSchema }),
  ]),
});
const MediaSchema = Schema.Struct({
  order: Schema.Finite,
  purpose: text(300),
  resourceKind: Schema.Literals(['MEDIA', 'DOCUMENT']),
  resourceRef: SymmyOwnerRefSchema,
});
const RelationshipSchema = Schema.Struct({
  effectivePeriod: Schema.optionalKey(EffectivePeriodSchema),
  target: Schema.Union([ProductRefSchema, VariantRefSchema]),
  type: Schema.Literals(['ACCESSORY_FOR', 'RELATED_PRODUCT', 'SUCCESSOR']),
});

/** A price exists only on a variant. Without a price group code it is the base price. */
const PriceSchema = Schema.Struct({
  amount: PriceNonNegativeDecimalSchema,
  commercialScope: Schema.optionalKey(
    Schema.Struct({
      channelRef: Schema.optionalKey(SymmyOwnerRefSchema),
      commerceMarketRef: Schema.optionalKey(MarketRefSchema),
      sellingLegalEntityRef: Schema.optionalKey(LegalEntityRefSchema),
    }),
  ),
  currencyCode: PricingCurrencyCodeSchema,
  effectiveFrom: Schema.optionalKey(instant),
  priceGroupCode: Schema.optionalKey(text(300)),
  unitBasis: Schema.optionalKey(Schema.Struct({ quantity: PricePositiveDecimalSchema, unitRef: ProductUnitRefSchema })),
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
  categories: Schema.optionalKey(Schema.Array(ProductCategoryRefSchema)),
  description: Schema.optionalKey(Schema.String.check(Schema.isMaxLength(4000))),
  gtin: Schema.optionalKey(GtinSchema),
  identifier: Schema.optionalKey(Schema.Struct({ type: Schema.Literals(['sku', 'ean', 'erpId']), value: text(300) })),
  lifecycle: Schema.optionalKey(Schema.Literals(['DRAFT', 'ACTIVE', 'RETIRED'])),
  localized: Schema.optionalKey(Schema.Array(LocalizedSchema)),
  manufacturer: Schema.optionalKey(ManufacturerSchema),
  media: Schema.optionalKey(Schema.Array(MediaSchema)),
  name: text(240),
  productType: Schema.optionalKey(ProductTypeRefSchema),
  relationships: Schema.optionalKey(Schema.Array(RelationshipSchema)),
  sizes: Schema.optionalKey(Schema.Array(SymmyOwnerRefSchema)),
  sku: Schema.optionalKey(text(300)),
  /** The first variant is the initial variant, created together with the product. */
  variants: Schema.NonEmptyArray(VariantSchema),
});

/**
 * The public body of `POST /products/batch`: one to sixteen products, each with at least one variant.
 * There is no product-level price and no version field.
 */
export const SymmyProductsBatchRequestSchema = Schema.Struct({
  products: Schema.NonEmptyArray(SymmyProductSchema).check(Schema.isMaxLength(16)),
});
export type SymmyProductsBatchRequest = typeof SymmyProductsBatchRequestSchema.Type;
