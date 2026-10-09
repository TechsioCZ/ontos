import { ActionAlreadyCommitted, ActionCommitIndeterminate, ActionRequestHashConflict } from '@app/core-runtime';
import type { ActionCoreError } from '@app/core-runtime';
import { describe, expect, it } from 'effect-rstest';

import { mapReactivateControlledAttributeValueActionProblem } from '../../api/reactivate-controlled-attribute-value-action-problems.ts';
import { mapReactivateProductActionProblem } from '../../api/reactivate-product-action-problems.ts';
import { mapReactivateVariantActionProblem } from '../../api/reactivate-variant-action-problems.ts';
import { mapRemoveCatalogMediaActionProblem } from '../../api/remove-catalog-media-action-problems.ts';
import { mapRemoveProductAttributeValuesActionProblem } from '../../api/remove-product-attribute-values-action-problems.ts';
import { mapRemoveProductCategoryAssignmentActionProblem } from '../../api/remove-product-category-assignment-action-problems.ts';
import { mapRemoveProductLocalizedFactsActionProblem } from '../../api/remove-product-localized-facts-action-problems.ts';

const invocationId = '33333333-3333-4333-8333-333333333333';

const cases: readonly {
  readonly map: (error: ActionCoreError) => { readonly status: number };
  readonly name: string;
  readonly resolution: string;
}[] = [
  {
    map: mapReactivateControlledAttributeValueActionProblem,
    name: 'reactivate-controlled-attribute-value',
    resolution: 'RECOVER_REACTIVATE_CONTROLLED_ATTRIBUTE_VALUE',
  },
  { map: mapReactivateProductActionProblem, name: 'reactivate-product', resolution: 'RECOVER_REACTIVATE_PRODUCT' },
  { map: mapReactivateVariantActionProblem, name: 'reactivate-variant', resolution: 'RECOVER_REACTIVATE_VARIANT' },
  { map: mapRemoveCatalogMediaActionProblem, name: 'remove-catalog-media', resolution: 'RECOVER_REMOVE_CATALOG_MEDIA' },
  {
    map: mapRemoveProductAttributeValuesActionProblem,
    name: 'remove-product-attribute-values',
    resolution: 'RECOVER_REMOVE_PRODUCT_ATTRIBUTE_VALUES',
  },
  {
    map: mapRemoveProductCategoryAssignmentActionProblem,
    name: 'remove-product-category-assignment',
    resolution: 'RECOVER_REMOVE_PRODUCT_CATEGORY_ASSIGNMENT',
  },
  {
    map: mapRemoveProductLocalizedFactsActionProblem,
    name: 'remove-product-localized-facts',
    resolution: 'RECOVER_REMOVE_PRODUCT_LOCALIZED_FACTS',
  },
];

for (const action of cases) {
  describe(`${action.name} recovery direction`, () => {
    it('directs a committed retry to the immutable result without replaying', () => {
      const problem = action.map(
        new ActionAlreadyCommitted({ code: 'action_already_committed', invocationId, reason: 'committed' }),
      );
      expect(problem).toMatchObject({ invocationId, resolution: action.resolution, retryCommand: false, status: 409 });
    });

    it('directs an uncertain commit to authoritative recovery', () => {
      const problem = action.map(
        new ActionCommitIndeterminate({ code: 'action_commit_indeterminate', invocationId, reason: 'uncertain' }),
      );
      expect(problem).toMatchObject({ invocationId, resolution: action.resolution, retryCommand: false, status: 503 });
    });

    it('keeps a changed payload a plain conflict without recovery direction', () => {
      const problem = action.map(
        new ActionRequestHashConflict({ code: 'action_request_hash_conflict', reason: 'different payload' }),
      );
      expect(problem.status).toBe(409);
      expect('resolution' in problem).toBe(false);
      expect('invocationId' in problem).toBe(false);
    });
  });
}
