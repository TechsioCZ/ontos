import { randomUUID } from 'node:crypto';

import type { Schema } from 'effect';

const catalogModule = 'commerce.catalog';

export const internalProductSource = {
  additionalVariantIdentifier: 'INTERNAL_C14_ADDITIONAL_VARIANT_A',
  initialVariantIdentifier: 'INTERNAL_C14_INITIAL_VARIANT_A',
  issuerId: 'INTERNAL_C14_NATIVE_ISSUER',
  mappingVersion: 'INTERNAL_C14_MAPPING_V1',
  namespace: 'INTERNAL_C14_PRODUCTS',
  productIdentifier: 'INTERNAL_C14_PRODUCT_A',
  routeRevision: 'INTERNAL_C14_ROUTE_V1',
} as const;

/** The source record ids the admission derives from the public identifiers. */
export const productRecordId = (identifier: string) => `product:erpId:${identifier}`;
export const variantRecordId = (identifier: string) => `variant:variantId:${identifier}`;

const operation = (moduleId: string, entrypointKey: string, schemaVersion: string) => ({
  entrypointKey,
  moduleId,
  schemaVersion,
});
export const createProductOperation = operation(catalogModule, 'commerce.catalog.create-product', '2');
export const createVariantOperation = operation(catalogModule, 'commerce.catalog.create-variant', '2');
export const updateProductOperation = operation(catalogModule, 'commerce.catalog.update-product', '1');
export const variantFactsOperation = operation(catalogModule, 'commerce.catalog.set-variant-localized-facts', '1');
export const definePriceOperation = operation('commerce.pricing', 'commerce.pricing.define-price', '2');

const enrolled = (entityKind: string, ...operations: readonly ReturnType<typeof operation>[]) => ({
  effects: operations.map((enrolledOperation, index) => ({
    effectKey: `authority-${index}`,
    operation: enrolledOperation,
  })),
  itemKey: `enrolled-${entityKind.toLowerCase()}`,
  source: {
    entityKind,
    issuerId: internalProductSource.issuerId,
    sourceNamespace: internalProductSource.namespace,
    sourceRecordId: `enrollment-${entityKind.toLowerCase()}`,
  },
});

/** What the price assertions of the route name: the grant refs and the one default scope and unit basis. */
export const internalProductPriceSource = (input: {
  readonly marketId: string;
  readonly unitRef: typeof Schema.Json.Type;
}) => ({
  defaults: {
    commercialScope: { channelId: 'B2C', marketId: input.marketId },
    unitBasis: { quantity: '1', unitRef: input.unitRef },
  },
  mapping: {
    mappingContractRef: 'INTERNAL_C14_PRICE_MAPPING',
    mappingContractVersion: internalProductSource.mappingVersion,
  },
  sourceAuthority: { sourceAuthorityRef: 'INTERNAL_C14_PRICE_AUTHORITY', sourceAuthorityVersion: 'v1' },
});

/** The route enrolls operations and grant refs, never a product, a variant or a price: the admission builds the plan. */
export const makeInternalC14ProductRouteTemplate = (input: {
  readonly marketId: string;
  readonly sourceRouteId: string;
  readonly unitRef: typeof Schema.Json.Type;
}) => ({
  items: [
    enrolled('PRODUCT', createProductOperation, updateProductOperation),
    enrolled('VARIANT', createVariantOperation, variantFactsOperation),
    enrolled('PRICE', definePriceOperation),
  ],
  priceSource: internalProductPriceSource(input),
  pricingSourceSystem: { ownerModuleId: 'external.internal-c14', sourceSystemRef: 'INTERNAL_C14_PRICE_SOURCE_SYSTEM' },
  sourceMappingVersion: internalProductSource.mappingVersion,
  sourceRouteId: input.sourceRouteId,
  sourceRouteRevision: internalProductSource.routeRevision,
});

const catalogRef = (tenantId: string, type: string, resourceId: string) => ({
  moduleId: catalogModule,
  resourceId,
  resourceType: `commerce.catalog.${type}`,
  tenantId,
});

/**
 * The public body of the first job: a product with an initial variant (localized text and a price) and a further
 * variant, plus every field no intent writes, so the job reports each group as unsupported.
 */
export const makeInternalC14ProductBody = (tenantId: string): Schema.Json => ({
  products: [
    {
      attributes: [{ attributeDefinitionRef: catalogRef(tenantId, 'attribute-definition', randomUUID()), values: [] }],
      categories: [catalogRef(tenantId, 'product-category', randomUUID())],
      identifier: { type: 'erpId', value: internalProductSource.productIdentifier },
      media: [
        {
          order: 1,
          purpose: 'GALLERY',
          resourceKind: 'MEDIA',
          resourceRef: catalogRef(tenantId, 'media', randomUUID()),
        },
      ],
      name: 'INTERNAL_C14 native Product',
      productType: catalogRef(tenantId, 'product-type', randomUUID()),
      sku: 'INTERNAL_C14_SKU',
      variants: [
        {
          identifier: { type: 'variantId', value: internalProductSource.initialVariantIdentifier },
          localized: [{ locale: 'en', name: 'INTERNAL_C14 initial Variant' }],
          prices: [{ amount: '25', currencyCode: 'CZK' }],
        },
        {
          identifier: { type: 'variantId', value: internalProductSource.additionalVariantIdentifier },
          lifecycle: 'ACTIVE',
        },
      ],
    },
  ],
});

/** The same source product and variants, named again with a new key: every create is a semantic replay. */
export const makeInternalC14ReplayBody = (extraVariants: readonly (typeof Schema.Json.Type)[] = []) => ({
  products: [
    {
      identifier: { type: 'erpId', value: internalProductSource.productIdentifier },
      name: 'INTERNAL_C14 native Product',
      variants: [
        { identifier: { type: 'variantId', value: internalProductSource.initialVariantIdentifier } },
        ...extraVariants,
      ],
    },
  ],
});
