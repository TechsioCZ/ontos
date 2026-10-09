import { describe, expect, it } from 'effect-rstest';

import { catalogAuthorityBundles, catalogPublicOperationContracts } from '../../shared/api.ts';
import { CreateProductUnitActionApi } from '../../shared/apis/create-product-unit-action.ts';
import { ReviseProductUnitActionApi } from '../../shared/apis/revise-product-unit-action.ts';
import { RetireProductUnitActionApi } from '../../shared/apis/retire-product-unit-action.ts';
import { SetProductUnitTargetDivisibilityActionApi } from '../../shared/apis/set-product-unit-target-divisibility-action.ts';
import { ProductUnitActionError } from '../../shared/actions/product-unit-contract.ts';
import { mapCreateProductUnitActionProblem } from '../../api/create-product-unit-action-problems.ts';
import { mapReviseProductUnitActionProblem } from '../../api/revise-product-unit-action-problems.ts';
import { mapRetireProductUnitActionProblem } from '../../api/retire-product-unit-action-problems.ts';
import { mapSetProductUnitTargetDivisibilityActionProblem } from '../../api/set-product-unit-target-divisibility-action-problems.ts';
import {
  executeCreateProductUnit,
  executeReviseProductUnit,
  executeRetireProductUnit,
  executeSetProductUnitTargetDivisibility,
} from '@app/catalog/api/client';

const actions = [
  ['commerce.catalog.create-product-unit', CreateProductUnitActionApi, executeCreateProductUnit],
  ['commerce.catalog.revise-product-unit', ReviseProductUnitActionApi, executeReviseProductUnit],
  ['commerce.catalog.retire-product-unit', RetireProductUnitActionApi, executeRetireProductUnit],
  [
    'commerce.catalog.set-product-unit-target-divisibility',
    SetProductUnitTargetDivisibilityActionApi,
    executeSetProductUnitTargetDivisibility,
  ],
] as const;
const mappers = [
  mapCreateProductUnitActionProblem,
  mapReviseProductUnitActionProblem,
  mapRetireProductUnitActionProblem,
  mapSetProductUnitTargetDivisibilityActionProblem,
] as const;

describe('Product Unit HTTP Actions', () => {
  it('publishes four independent tenant-scoped Action transports and permissions', () => {
    for (const [key, api, client] of actions) {
      expect(api).toBeDefined();
      expect(client).toBeDefined();
      expect(catalogPublicOperationContracts[key]).toEqual({
        authorityBundle: 'CATALOG_DEFINITION_MANAGER',
        businessTarget: 'product-unit',
        permission: key,
        permissionKind: 'action_execution',
        scope: 'tenant',
        version: '1',
      });
      expect(catalogAuthorityBundles.CATALOG_DEFINITION_MANAGER).toContain(key);
    }
  });

  it('maps domain failures to redacted and distinct conflict, ineligibility, and retryable statuses', () => {
    for (const map of mappers) {
      for (const [code, status, retryable] of [
        ['product_unit_invalid', 422, undefined],
        ['product_unit_stale', 409, undefined],
        ['product_unit_unavailable', 503, true],
      ] as const) {
        const problem = map(new ProductUnitActionError({ code, reason: 'private persistence and identity detail' }));
        expect(problem).toMatchObject({ code, status });
        if (retryable) {
          expect(problem).toMatchObject({ retryable: true });
        }
        expect(JSON.stringify(problem)).not.toContain('private persistence and identity detail');
      }
    }
  });
});
