import type { ActionHandlerContext, DomainEventContractMap } from '@app/core-runtime';
import { Effect, Schema } from 'effect';

import type { ProductRelationshipEndpoint } from '../../shared/domain/product-relationship.ts';
import { CatalogPersistenceUnavailable } from '../persistence/errors.ts';
import { productRelationshipPersistenceForScope } from '../persistence/product-relationship-persistence.ts';
import type { ProductRelationshipPersistence } from '../persistence/product-relationship-persistence.ts';
import { ProductRelationshipActionNotFound } from './product-relationship-action-not-found.ts';

export const relationshipPersistenceServiceFactory = (
  ...args: Parameters<typeof productRelationshipPersistenceForScope>
) => Effect.succeed(productRelationshipPersistenceForScope(...args));

export class ProductRelationshipActionConflict extends Schema.TaggedError<ProductRelationshipActionConflict>()(
  'ProductRelationshipActionConflict',
  {
    code: Schema.Literal('product_relationship_conflict'),
    conflict: Schema.Literals(['REVISION', 'DUPLICATE', 'IDENTITY', 'LIFECYCLE', 'INVALID_CHANGE']),
    reason: Schema.String,
  },
) {}

export const ProductRelationshipActionErrorSchema = Schema.Union([
  ProductRelationshipActionConflict,
  ProductRelationshipActionNotFound,
  CatalogPersistenceUnavailable,
]);
export { ProductAuditEvidenceSchema } from '../../shared/domain/product.ts';

export const relationshipNotFound = () =>
  new ProductRelationshipActionNotFound({
    code: 'product_relationship_not_found',
    reason: 'Relationship or endpoint was not found in the trusted Tenant',
  });

export const relationshipConflict = (conflict: ProductRelationshipActionConflict['conflict']) =>
  new ProductRelationshipActionConflict({
    code: 'product_relationship_conflict',
    conflict,
    reason: 'Relationship cannot be changed from its current state',
  });

export const checkRelationshipTenant = (tenantId: string, endpoint: ProductRelationshipEndpoint) =>
  tenantId === endpoint.tenantId ? Effect.void : Effect.fail(relationshipNotFound());

export const recordRelationshipAccess = <Events extends DomainEventContractMap>(
  context: ActionHandlerContext<Events, ProductRelationshipPersistence>,
  endpoint: ProductRelationshipEndpoint,
) =>
  context.recordDataAccess({
    accessKind: 'read',
    queryHash: `catalog-relationship-endpoint:${endpoint.resourceType}:${endpoint.resourceId}`,
    resultCount: 1,
    servingModuleKey: 'commerce.catalog',
    targetModuleKey: 'commerce.catalog',
    targetResourceId: endpoint.resourceId,
    targetResourceType: endpoint.resourceType,
  });
