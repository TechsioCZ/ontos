import { ActionAlreadyCommitted, ActionCommitIndeterminate, ActionRequestHashConflict } from '@app/core-runtime';
import type { ActionCoreError } from '@app/core-runtime';
import { describe, expect, it } from 'effect-rstest';

import { mapChangeProductRelationshipActionProblem } from '../../api/change-product-relationship-action-problems.ts';
import { mapChangeVariantActionProblem } from '../../api/change-variant-action-problems.ts';
import { mapConfirmGtinActionProblem } from '../../api/confirm-gtin-action-problems.ts';
import { mapCorrectGtinActionProblem } from '../../api/correct-gtin-action-problems.ts';
import { mapCorrectProductActionProblem } from '../../api/correct-product-action-problems.ts';
import { mapCorrectSkuActionProblem } from '../../api/correct-sku-action-problems.ts';
import { mapDecideProductTypeUnnecessaryActionProblem } from '../../api/decide-product-type-unnecessary-action-problems.ts';

const invocationId = '33333333-3333-4333-8333-333333333333';

interface RecoveryProblem {
  readonly invocationId?: string;
  readonly resolution?: string;
  readonly retryCommand?: boolean;
  readonly status: number;
}

const cases: readonly {
  readonly map: (error: ActionCoreError) => RecoveryProblem;
  readonly name: string;
  readonly resolution: string;
}[] = [
  {
    map: mapChangeProductRelationshipActionProblem,
    name: 'change-product-relationship',
    resolution: 'RECOVER_CHANGE_PRODUCT_RELATIONSHIP',
  },
  { map: mapChangeVariantActionProblem, name: 'change-variant', resolution: 'RECOVER_CHANGE_VARIANT' },
  { map: mapConfirmGtinActionProblem, name: 'confirm-gtin', resolution: 'RECOVER_CONFIRM_GTIN' },
  { map: mapCorrectGtinActionProblem, name: 'correct-gtin', resolution: 'RECOVER_CORRECT_GTIN' },
  { map: mapCorrectProductActionProblem, name: 'correct-product', resolution: 'RECOVER_CORRECT_PRODUCT' },
  { map: mapCorrectSkuActionProblem, name: 'correct-sku', resolution: 'RECOVER_CORRECT_SKU' },
  {
    map: mapDecideProductTypeUnnecessaryActionProblem,
    name: 'decide-product-type-unnecessary',
    resolution: 'RECOVER_DECIDE_PRODUCT_TYPE_UNNECESSARY',
  },
];

for (const action of cases) {
  describe(`${action.name} recovery direction`, () => {
    it('recovers the immutable committed result by invocation', () => {
      const problem = action.map(
        new ActionAlreadyCommitted({ code: 'action_already_committed', invocationId, reason: 'committed' }),
      );
      expect(problem).toMatchObject({ invocationId, resolution: action.resolution, retryCommand: false, status: 409 });
    });

    it('resolves uncertain commit through authoritative recovery', () => {
      const problem = action.map(
        new ActionCommitIndeterminate({ code: 'action_commit_indeterminate', invocationId, reason: 'uncertain' }),
      );
      expect(problem).toMatchObject({ invocationId, resolution: action.resolution, retryCommand: false, status: 503 });
    });

    it('keeps a different payload a plain conflict', () => {
      const problem = action.map(
        new ActionRequestHashConflict({ code: 'action_request_hash_conflict', reason: 'different payload' }),
      );
      expect(problem.status).toBe(409);
      expect('resolution' in problem).toBe(false);
      expect('invocationId' in problem).toBe(false);
    });
  });
}
