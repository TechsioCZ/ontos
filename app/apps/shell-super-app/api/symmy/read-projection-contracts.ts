import { ProductSchema, ProductUuidSchema } from '@app/catalog/domain/product';
import { CatalogSourceCorrelationSchema } from '@app/catalog/domain/catalog-source-correlation';
import { PriceGroupRefSchema } from '@app/price-group-catalog/resources/price-group';
import { PriceGroupSourcePricesResponseSchema } from '@app/pricing/apis/price-group-source-prices';
import { CustomerProfileSourceItemSchema } from '@app/commerce-customer-context/api/customer-profile-source';
import { SourceProfileExportResponseSchema } from '@app/party-registry/apis/source-profile-export';
import { OrganizationBusinessNameExportResponseSchema } from '@app/party-registry/apis/organization-business-name-export';
import { PricingInstantSchema } from '@app/pricing-contracts/current-supported-currencies';
import { Schema } from 'effect';
import { SymmyEncodedSourceCodeSchema } from '@app/symmy-integration/symmy-source-selector';

const sourceId = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(300), Schema.isTrimmed()).pipe(
  Schema.brand('SymmyReadSourceRecordId'),
  Schema.decodeTo(Schema.String),
);
const limit = Schema.Int.check(Schema.isBetween({ maximum: 100, minimum: 1 }));

/** Source IDs round-trip independently of the actual owner references. No legacy status is inferred. */
export const SymmyInternalProductsProjectionSchema = Schema.Struct({
  contractVersion: Schema.Literal('INTERNAL_C14'),
  limit,
  nextRecordId: Schema.optionalKey(sourceId),
  products: Schema.Array(
    Schema.Struct({
      id: CatalogSourceCorrelationSchema.fields.recordId,
      product: ProductSchema,
      variantSources: Schema.Array(Schema.Struct({ id: sourceId, variantId: ProductUuidSchema })),
    }),
  ),
  projection: Schema.Literal('products'),
  unsupported_fields: Schema.Tuple([
    Schema.Literal('tax'),
    Schema.Literal('assortment'),
    Schema.Literal('prices'),
    Schema.Literal('stock'),
  ]),
});
export type SymmyInternalProductsProjection = typeof SymmyInternalProductsProjectionSchema.Type;

/** A native Price Group projection; a Price List is never created as another canonical aggregate. */
export const SymmyInternalPriceListsProjectionSchema = Schema.Struct({
  contractVersion: Schema.Literal('INTERNAL_C14'),
  count: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  limit,
  offset: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  price_lists: Schema.Array(
    Schema.Struct({
      description: Schema.String,
      ends_at: Schema.optionalKey(PricingInstantSchema),
      id: Schema.toEncoded(SymmyEncodedSourceCodeSchema),
      name: Schema.String,
      priceGroupRef: PriceGroupRefSchema,
      prices: Schema.optionalKey(PriceGroupSourcePricesResponseSchema),
      source_record_id: sourceId,
      starts_at: PricingInstantSchema,
    }),
  ),
  projection: Schema.Literal('price_lists'),
  unsupported_fields: Schema.Array(Schema.Literal('prices')).check(Schema.isMaxLength(1)),
});
export type SymmyInternalPriceListsProjection = typeof SymmyInternalPriceListsProjectionSchema.Type;

export const SymmyCustomerIcoProjectionSchema = Schema.Union([
  Schema.TaggedStruct('PRESENT', { normalizedValue: Schema.String }),
  Schema.TaggedStruct('ABSENT', {}),
  Schema.TaggedStruct('MIGRATION_REQUIRED', {}),
]);

export const SymmyInternalCustomersProjectionSchema = Schema.Struct({
  contractVersion: Schema.Literal('INTERNAL_C14'),
  customers: Schema.Array(
    Schema.Struct({
      business_name: Schema.optionalKey(OrganizationBusinessNameExportResponseSchema.members[1].fields.businessName),
      ico: Schema.optionalKey(SymmyCustomerIcoProjectionSchema),
      id: sourceId,
      party: Schema.optionalKey(SourceProfileExportResponseSchema.members[1]),
      partyRef: CustomerProfileSourceItemSchema.fields.partyRef,
      profile: CustomerProfileSourceItemSchema.fields.profile,
    }),
  ),
  limit,
  nextRecordId: Schema.optionalKey(sourceId),
  projection: Schema.Literal('customers'),
  unsupported_fields: Schema.Array(Schema.Literals(['name', 'contacts', 'addresses', 'groups', 'ico'])),
});
export type SymmyInternalCustomersProjection = typeof SymmyInternalCustomersProjectionSchema.Type;
