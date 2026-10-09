import { ActionAlreadyCommitted, ActionCommitIndeterminate, ActionRequestHashConflict } from '@app/core-runtime';
import type { ActionCoreError } from '@app/core-runtime';
import { describe, expect, it } from 'effect-rstest';
import { mapActivatePackageDefinitionActionProblem } from '../../api/activate-package-definition-action-problems.ts';
import { mapActivatePackageOptionActionProblem } from '../../api/activate-package-option-action-problems.ts';
import { mapAddProductCategoryAssignmentActionProblem } from '../../api/add-product-category-assignment-action-problems.ts';
import { mapAssertSizeEquivalenceActionProblem } from '../../api/assert-size-equivalence-action-problems.ts';
import { mapAssignCatalogMediaActionProblem } from '../../api/assign-catalog-media-action-problems.ts';
import { mapAssignSkuActionProblem } from '../../api/assign-sku-action-problems.ts';
import { mapChangeProductManufacturerActionProblem } from '../../api/change-product-manufacturer-action-problems.ts';

const invocationId = '33333333-3333-4333-8333-333333333333';

const cases: readonly {
  action: string;
  map: (error: ActionCoreError) => { readonly status: number };
  resolution: string;
}[] = [
  {
    action: 'activate package definition',
    map: mapActivatePackageDefinitionActionProblem,
    resolution: 'RECOVER_ACTIVATE_PACKAGE_DEFINITION',
  },
  {
    action: 'activate package option',
    map: mapActivatePackageOptionActionProblem,
    resolution: 'RECOVER_ACTIVATE_PACKAGE_OPTION',
  },
  {
    action: 'add product category assignment',
    map: mapAddProductCategoryAssignmentActionProblem,
    resolution: 'RECOVER_ADD_PRODUCT_CATEGORY_ASSIGNMENT',
  },
  {
    action: 'assert size equivalence',
    map: mapAssertSizeEquivalenceActionProblem,
    resolution: 'RECOVER_ASSERT_SIZE_EQUIVALENCE',
  },
  {
    action: 'assign catalog media',
    map: mapAssignCatalogMediaActionProblem,
    resolution: 'RECOVER_ASSIGN_CATALOG_MEDIA',
  },
  { action: 'assign SKU', map: mapAssignSkuActionProblem, resolution: 'RECOVER_ASSIGN_SKU' },
  {
    action: 'change product manufacturer',
    map: mapChangeProductManufacturerActionProblem,
    resolution: 'RECOVER_CHANGE_PRODUCT_MANUFACTURER',
  },
];

describe('Catalog Action-specific recovery direction', () => {
  for (const { action, map, resolution } of cases) {
    it(`${action} recovers the committed result by invocation`, () => {
      const problem = map(
        new ActionAlreadyCommitted({ code: 'action_already_committed', invocationId, reason: 'committed' }),
      );
      expect(problem).toMatchObject({ invocationId, resolution, retryCommand: false, status: 409 });
    });

    it(`${action} resolves an uncertain commit before replay`, () => {
      const problem = map(
        new ActionCommitIndeterminate({ code: 'action_commit_indeterminate', invocationId, reason: 'uncertain' }),
      );
      expect(problem).toMatchObject({ invocationId, resolution, retryCommand: false, status: 503 });
    });

    it(`${action} keeps mismatched payloads as plain conflicts`, () => {
      const problem = map(
        new ActionRequestHashConflict({ code: 'action_request_hash_conflict', reason: 'different payload' }),
      );
      expect(problem.status).toBe(409);
      expect('resolution' in problem).toBe(false);
      expect('invocationId' in problem).toBe(false);
    });
  }
});
