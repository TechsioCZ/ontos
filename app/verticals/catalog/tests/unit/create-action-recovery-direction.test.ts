import { ActionAlreadyCommitted, ActionCommitIndeterminate, ActionRequestHashConflict } from '@app/core-runtime';
import type { ActionCoreError } from '@app/core-runtime';
import { describe, expect, it } from 'effect-rstest';
import { mapCreateAttributeDefinitionActionProblem } from '../../api/create-attribute-definition-action-problems.ts';
import { mapCreateBrandActionProblem } from '../../api/create-brand-action-problems.ts';
import { mapCreateConfigurationUnitActionProblem } from '../../api/create-configuration-unit-action-problems.ts';
import { mapCreateControlledAttributeValueActionProblem } from '../../api/create-controlled-attribute-value-action-problems.ts';
import { mapCreatePackageDefinitionActionProblem } from '../../api/create-package-definition-action-problems.ts';
import { mapCreateProductCategoryActionProblem } from '../../api/create-product-category-action-problems.ts';
import { mapCreateProductRelationshipActionProblem } from '../../api/create-product-relationship-action-problems.ts';
import { mapCreateProductTypeActionProblem } from '../../api/create-product-type-action-problems.ts';
import { mapCreateProductUnitActionProblem } from '../../api/create-product-unit-action-problems.ts';
import { mapCreateSetCompositionActionProblem } from '../../api/create-set-composition-action-problems.ts';
import { mapCreateVariantActionProblem } from '../../api/create-variant-action-problems.ts';

const invocationId = '33333333-3333-4333-8333-333333333333';

const cases: readonly {
  action: string;
  map: (error: ActionCoreError) => { readonly status: number };
  resolution: string;
}[] = [
  {
    action: 'create attribute definition',
    map: mapCreateAttributeDefinitionActionProblem,
    resolution: 'RECOVER_CREATE_ATTRIBUTE_DEFINITION',
  },
  { action: 'create brand', map: mapCreateBrandActionProblem, resolution: 'RECOVER_CREATE_BRAND' },
  {
    action: 'create configuration unit',
    map: mapCreateConfigurationUnitActionProblem,
    resolution: 'RECOVER_CREATE_CONFIGURATION_UNIT',
  },
  {
    action: 'create controlled attribute value',
    map: mapCreateControlledAttributeValueActionProblem,
    resolution: 'RECOVER_CREATE_CONTROLLED_ATTRIBUTE_VALUE',
  },
  {
    action: 'create package definition',
    map: mapCreatePackageDefinitionActionProblem,
    resolution: 'RECOVER_CREATE_PACKAGE_DEFINITION',
  },
  {
    action: 'create product category',
    map: mapCreateProductCategoryActionProblem,
    resolution: 'RECOVER_CREATE_PRODUCT_CATEGORY',
  },
  {
    action: 'create product relationship',
    map: mapCreateProductRelationshipActionProblem,
    resolution: 'RECOVER_CREATE_PRODUCT_RELATIONSHIP',
  },
  {
    action: 'create product type',
    map: mapCreateProductTypeActionProblem,
    resolution: 'RECOVER_CREATE_PRODUCT_TYPE',
  },
  {
    action: 'create product unit',
    map: mapCreateProductUnitActionProblem,
    resolution: 'RECOVER_CREATE_PRODUCT_UNIT',
  },
  {
    action: 'create set composition',
    map: mapCreateSetCompositionActionProblem,
    resolution: 'RECOVER_CREATE_SET_COMPOSITION',
  },
  { action: 'create variant', map: mapCreateVariantActionProblem, resolution: 'RECOVER_CREATE_VARIANT' },
];

describe('Catalog create-Action recovery direction', () => {
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
