import type { ActionHandlerContext, DomainEventContractMap } from '@app/core-runtime';
import { Effect, Schema } from 'effect';

import {
  ProductCorrectionRequired,
  ProductLifecycleConflict,
  ProductNotCatalogReady,
  ProductNotFound,
  ProductPersistenceConflict,
  ProductRevisionConflict,
} from '../../shared/domain/product-errors.ts';
import type { ProductRef } from '../../shared/resources/product.ts';
import { CatalogPersistenceConflict, CatalogPersistenceUnavailable } from '../persistence/errors.ts';
import type { CatalogPersistence } from '../persistence/catalog-persistence.ts';

export { catalogPersistenceWithCurrentSelectionEvidenceForScope as catalogPersistenceServiceFactory } from '../persistence/catalog-persistence.ts';

const CATALOG_MODULE_KEY = 'commerce.catalog' as const;
const PRODUCT_RESOURCE_TYPE = 'commerce.catalog.product' as const;

export const ProductActionErrorSchema = Schema.Union([
  ProductNotFound,
  ProductRevisionConflict,
  ProductLifecycleConflict,
  ProductNotCatalogReady,
  ProductCorrectionRequired,
  ProductPersistenceConflict,
  CatalogPersistenceConflict,
  CatalogPersistenceUnavailable,
]);

export type ProductEventContext<Events extends DomainEventContractMap> = ActionHandlerContext<
  Events,
  CatalogPersistence
>;

export const invalidCrossTenantProduct = (productRef: ProductRef) =>
  new ProductNotFound({
    code: 'product_not_found',
    productRef,
    reason: 'The Product does not belong to the trusted tenant scope',
  });

export const productNotFound = (productRef: ProductRef) =>
  new ProductNotFound({
    code: 'product_not_found',
    productRef,
    reason: 'The Product could not be found in the trusted tenant scope',
  });

export const productRevisionConflict = (productRef: ProductRef, expectedRevision: number, actualRevision: number) =>
  new ProductRevisionConflict({
    actualRevision,
    code: 'product_revision_conflict',
    expectedRevision,
    productRef,
    reason: 'The Product changed before this Action committed',
  });

export const productLifecycleConflict = (productRef: ProductRef, reason: string) =>
  new ProductLifecycleConflict({
    code: 'product_lifecycle_conflict',
    productRef,
    reason,
  });

export const productNotCatalogReady = (productRef: ProductRef, reasons: readonly string[]) =>
  new ProductNotCatalogReady({
    code: 'product_not_catalog_ready',
    productRef,
    reason: 'The Product is not ready for Catalog use',
    reasons,
  });

export const recordProductAccess = Effect.fn('CatalogProductAction.recordAccess')(function* recordProductAccess<
  Events extends DomainEventContractMap,
>(context: ProductEventContext<Events>, productId: string) {
  yield* context.recordDataAccess({
    accessKind: 'read',
    queryHash: `catalog-product:${productId}`,
    resultCount: 1,
    servingModuleKey: CATALOG_MODULE_KEY,
    targetModuleKey: CATALOG_MODULE_KEY,
    targetResourceId: productId,
    targetResourceType: PRODUCT_RESOURCE_TYPE,
  });
});

export const recordProductEvent = Effect.fn('CatalogProductAction.recordEvent')(function* recordProductEvent<
  Events extends DomainEventContractMap,
>(
  context: ProductEventContext<Events>,
  eventType: keyof Events & string,
  productId: string,
  payloadJson: Schema.Schema.Type<typeof Schema.Json>,
) {
  return yield* context.addDomainEvent({
    eventType,
    payloadJson,
    producerModuleKey: CATALOG_MODULE_KEY,
    subjectModuleKey: CATALOG_MODULE_KEY,
    subjectResourceId: productId,
    subjectResourceType: PRODUCT_RESOURCE_TYPE,
  });
});
