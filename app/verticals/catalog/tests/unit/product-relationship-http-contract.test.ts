import { describe, expect, it } from 'effect-rstest';

import { catalogAuthorityBundles, catalogPublicOperationContracts } from '../../shared/api.ts';
import { ChangeProductRelationshipActionApi } from '../../shared/apis/change-product-relationship-action.ts';
import { CreateProductRelationshipActionApi } from '../../shared/apis/create-product-relationship-action.ts';
import { RemoveProductRelationshipActionApi } from '../../shared/apis/remove-product-relationship-action.ts';
import { mapChangeProductRelationshipActionProblem } from '../../api/change-product-relationship-action-problems.ts';
import { mapCreateProductRelationshipActionProblem } from '../../api/create-product-relationship-action-problems.ts';
import { mapRemoveProductRelationshipActionProblem } from '../../api/remove-product-relationship-action-problems.ts';
import { ProductRelationshipActionConflict } from '../../src/actions/product-relationship-action-support.ts';
import { ProductRelationshipActionNotFound } from '../../src/actions/product-relationship-action-not-found.ts';
import { CatalogPersistenceUnavailable } from '../../src/persistence/errors.ts';
import {
  executeChangeProductRelationship,
  executeCreateProductRelationship,
  executeRemoveProductRelationship,
} from '@app/catalog/api/client';

const actions = [
  [
    'commerce.catalog.change-product-relationship',
    ChangeProductRelationshipActionApi,
    executeChangeProductRelationship,
  ],
  [
    'commerce.catalog.create-product-relationship',
    CreateProductRelationshipActionApi,
    executeCreateProductRelationship,
  ],
  [
    'commerce.catalog.remove-product-relationship',
    RemoveProductRelationshipActionApi,
    executeRemoveProductRelationship,
  ],
] as const;

const mappers = [
  mapChangeProductRelationshipActionProblem,
  mapCreateProductRelationshipActionProblem,
  mapRemoveProductRelationshipActionProblem,
] as const;

describe('Product relationship HTTP Actions', () => {
  it('publishes separate typed transports with tenant-atomic permissions', () => {
    for (const [key, api, client] of actions) {
      expect(api).toBeDefined();
      expect(client).toBeDefined();
      expect(catalogPublicOperationContracts[key]).toEqual({
        authorityBundle: 'PRODUCT_EDITOR',
        businessTarget: 'product-relationship',
        permission: key,
        permissionKind: 'action_execution',
        scope: 'tenant',
        version: '1',
      });
      expect(catalogAuthorityBundles.PRODUCT_EDITOR).toContain(key);
    }
  });

  it('maps exact conflicts, invalid changes, absence and unavailability without leaking reasons', () => {
    for (const map of mappers) {
      for (const conflict of ['DUPLICATE', 'REVISION', 'IDENTITY', 'LIFECYCLE'] as const) {
        const problem = map(
          new ProductRelationshipActionConflict({
            code: 'product_relationship_conflict',
            conflict,
            reason: 'private relationship identity',
          }),
        );
        expect(problem).toMatchObject({ code: 'product_relationship_conflict', status: 409 });
        expect(JSON.stringify(problem)).not.toContain('private relationship identity');
      }
      expect(
        map(
          new ProductRelationshipActionConflict({
            code: 'product_relationship_conflict',
            conflict: 'INVALID_CHANGE',
            reason: 'private invalid change',
          }),
        ),
      ).toMatchObject({ code: 'product_relationship_invalid', status: 422 });
      expect(
        map(
          new ProductRelationshipActionNotFound({
            code: 'product_relationship_not_found',
            reason: 'private missing endpoint',
          }),
        ),
      ).toMatchObject({ code: 'product_relationship_not_found', status: 404 });
      expect(
        map(
          new CatalogPersistenceUnavailable({
            code: 'catalog_persistence_unavailable',
            reason: 'private database detail',
          }),
        ),
      ).toMatchObject({ code: 'catalog_persistence_unavailable', retryable: true, status: 503 });
    }
  });
});
