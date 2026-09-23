import { ActionAlreadyCommitted, ActionCommitIndeterminate, ActionRequestHashConflict } from '@app/core-runtime';
import type { ActionCoreError } from '@app/core-runtime';
import { describe, expect, it } from 'effect-rstest';
import { mapRenameProductCategoryActionProblem } from '../../api/rename-product-category-action-problems.ts';
import { mapRenameSkuActionProblem } from '../../api/rename-sku-action-problems.ts';
import { mapReorderCatalogMediaActionProblem } from '../../api/reorder-catalog-media-action-problems.ts';
import { mapReplaceProductSizesActionProblem } from '../../api/replace-product-sizes-action-problems.ts';
import { mapSetProductAttributeValuesActionProblem } from '../../api/set-product-attribute-values-action-problems.ts';
import { mapSetProductBrandActionProblem } from '../../api/set-product-brand-action-problems.ts';
import { mapSetProductLocalizedFactsActionProblem } from '../../api/set-product-localized-facts-action-problems.ts';

const invocationId = '33333333-3333-4333-8333-333333333333';

type MapProblem = (error: ActionCoreError) => {
  readonly invocationId?: string;
  readonly resolution?: string;
  readonly retryCommand?: boolean;
  readonly status: number;
};

const cases: readonly { action: string; map: MapProblem; resolution: string }[] = [
  {
    action: 'rename-product-category',
    map: mapRenameProductCategoryActionProblem,
    resolution: 'RECOVER_RENAME_PRODUCT_CATEGORY',
  },
  { action: 'rename-sku', map: mapRenameSkuActionProblem, resolution: 'RECOVER_RENAME_SKU' },
  {
    action: 'reorder-catalog-media',
    map: mapReorderCatalogMediaActionProblem,
    resolution: 'RECOVER_REORDER_CATALOG_MEDIA',
  },
  {
    action: 'replace-product-sizes',
    map: mapReplaceProductSizesActionProblem,
    resolution: 'RECOVER_REPLACE_PRODUCT_SIZES',
  },
  {
    action: 'set-product-attribute-values',
    map: mapSetProductAttributeValuesActionProblem,
    resolution: 'RECOVER_SET_PRODUCT_ATTRIBUTE_VALUES',
  },
  { action: 'set-product-brand', map: mapSetProductBrandActionProblem, resolution: 'RECOVER_SET_PRODUCT_BRAND' },
  {
    action: 'set-product-localized-facts',
    map: mapSetProductLocalizedFactsActionProblem,
    resolution: 'RECOVER_SET_PRODUCT_LOCALIZED_FACTS',
  },
];

describe('Catalog Action-specific recovery direction', () => {
  for (const { action, map, resolution } of cases) {
    it(`${action} recovers an already committed result by invocation`, () => {
      const problem = map(
        new ActionAlreadyCommitted({ code: 'action_already_committed', invocationId, reason: 'committed' }),
      );
      expect(problem).toMatchObject({ invocationId, resolution, retryCommand: false, status: 409 });
    });

    it(`${action} resolves an uncertain commit through recovery`, () => {
      const problem = map(
        new ActionCommitIndeterminate({ code: 'action_commit_indeterminate', invocationId, reason: 'uncertain' }),
      );
      expect(problem).toMatchObject({ invocationId, resolution, retryCommand: false, status: 503 });
    });

    it(`${action} leaves a mismatched payload as a plain conflict`, () => {
      const problem = map(
        new ActionRequestHashConflict({ code: 'action_request_hash_conflict', reason: 'different payload' }),
      );
      expect(problem.status).toBe(409);
      expect('resolution' in problem).toBe(false);
      expect('invocationId' in problem).toBe(false);
    });
  }
});
