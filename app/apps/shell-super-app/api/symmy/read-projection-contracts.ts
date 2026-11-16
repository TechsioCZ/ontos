import { ProductSchema, ProductUuidSchema } from '@app/catalog/domain/product';
import { CatalogSourceCorrelationSchema } from '@app/catalog/domain/catalog-source-correlation';
import { PriceGroupSourcePricesResponseSchema } from '@app/pricing/apis/price-group-source-prices';
import { CustomerProfileSourceItemSchema } from '@app/commerce-customer-context/api/customer-profile-source';
import { SourceProfileExportResponseSchema } from '@app/party-registry/apis/source-profile-export';
import { OrganizationBusinessNameExportResponseSchema } from '@app/party-registry/apis/organization-business-name-export';
import { PricingInstantSchema } from '@app/pricing-contracts/current-supported-currencies';
import { sha256 } from '@noble/hashes/sha2.js';
import { utf8ToBytes } from '@noble/hashes/utils.js';
import { Result, Schema } from 'effect';
import { Base64Url } from 'effect/encoding';
import { SymmyEncodedSourceCodeSchema } from '@app/symmy-integration/symmy-source-selector';

const sourceId = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(300), Schema.isTrimmed()).pipe(
  Schema.brand('SymmyReadSourceRecordId'),
  Schema.decodeTo(Schema.String),
);
const limit = Schema.Int.check(Schema.isBetween({ maximum: 100, minimum: 1 }));
export const SymmyQualifiedReadIdSchema = Schema.String.check(Schema.isPattern(/^~c14r1\.[a-zA-Z0-9_-]{43}$/u)).pipe(
  Schema.brand('SymmyQualifiedReadId'),
);
const encodeReadIdentity = Schema.encodeResult(
  Schema.fromJsonString(
    Schema.Tuple([Schema.String, Schema.String, Schema.String, Schema.String, Schema.String, Schema.String]),
  ),
);

/** Stable read identity derived only from the qualified source and literal record key. */
export const qualifySymmyReadId = (
  scope: {
    readonly issuerId: string;
    readonly routeId: string;
    readonly sourceNamespace: string;
    readonly sourceRouteId?: string;
    readonly tenantId: string;
  },
  kind: 'PRODUCT' | 'VARIANT' | 'REGION' | `CUSTOMER:${string}`,
  recordId: string,
): typeof SymmyQualifiedReadIdSchema.Type => {
  const identity = Result.getOrThrow(
    encodeReadIdentity([
      scope.tenantId,
      scope.sourceRouteId ?? scope.routeId,
      scope.issuerId,
      scope.sourceNamespace,
      kind,
      recordId,
    ]),
  );
  return SymmyQualifiedReadIdSchema.make(`~c14r1.${Base64Url.encode(sha256(utf8ToBytes(identity)))}`);
};

/**
 * The internal read contract keeps literal source keys for scoped lookup and owner commands.
 * Only the typed Catalog Product and its Variant links carry native references, for exact update round-trips.
 */
export const SymmyInternalProductsProjectionSchema = Schema.Struct({
  contractVersion: Schema.Literal('INTERNAL_C14'),
  limit,
  nextRecordId: Schema.optionalKey(sourceId),
  products: Schema.Array(
    Schema.Struct({
      id: SymmyQualifiedReadIdSchema,
      product: ProductSchema,
      source_record_id: CatalogSourceCorrelationSchema.fields.recordId,
      variantSources: Schema.Array(
        Schema.Struct({
          id: SymmyQualifiedReadIdSchema,
          source_record_id: CatalogSourceCorrelationSchema.fields.recordId,
          variantId: ProductUuidSchema,
        }),
      ),
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

/**
 * The qualified selector carries the bounded owner lookup hint used by selected write routes.
 * Native Pricing references are limited to the separately authorized Price page and its typed provenance.
 */
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

/** Native references are limited to the verified Commerce profile/subject and authorized Party projection. */
export const SymmyInternalCustomersProjectionSchema = Schema.Struct({
  contractVersion: Schema.Literal('INTERNAL_C14'),
  customers: Schema.Array(
    Schema.Struct({
      business_name: Schema.optionalKey(OrganizationBusinessNameExportResponseSchema.members[1].fields.businessName),
      ico: Schema.optionalKey(SymmyCustomerIcoProjectionSchema),
      id: SymmyQualifiedReadIdSchema,
      party: Schema.optionalKey(SourceProfileExportResponseSchema.members[1]),
      partyRef: CustomerProfileSourceItemSchema.fields.partyRef,
      profile: CustomerProfileSourceItemSchema.fields.profile,
      source_record_id: sourceId,
    }),
  ),
  limit,
  nextRecordId: Schema.optionalKey(sourceId),
  projection: Schema.Literal('customers'),
  unsupported_fields: Schema.Array(Schema.Literals(['name', 'contacts', 'addresses', 'groups', 'ico'])),
});
export type SymmyInternalCustomersProjection = typeof SymmyInternalCustomersProjectionSchema.Type;
