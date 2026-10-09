import { ActionAlreadyCommitted, ActionCommitIndeterminate, ActionRequestHashConflict } from '@app/core-runtime';
import type { ActionCoreError } from '@app/core-runtime';
import { describe, expect, it } from 'effect-rstest';

import { mapGovernProductAttributeApplicabilityActionProblem } from '../../api/govern-product-attribute-applicability-action-problems.ts';
import { mapGovernVariantAxesActionProblem } from '../../api/govern-variant-axes-action-problems.ts';
import { mapMarkGtinUnresolvedActionProblem } from '../../api/mark-gtin-unresolved-action-problems.ts';
import { mapMoveProductCategoryActionProblem } from '../../api/move-product-category-action-problems.ts';
import { mapPromotePackageDefinitionActionProblem } from '../../api/promote-package-definition-action-problems.ts';
import { mapPublishProductConfigurationActionProblem } from '../../api/publish-product-configuration-action-problems.ts';
import { mapReactivateBrandActionProblem } from '../../api/reactivate-brand-action-problems.ts';

const invocationId = '33333333-3333-4333-8333-333333333333';
const actions: readonly { readonly mapProblem: (error: ActionCoreError) => object; readonly resolution: string }[] = [
  {
    mapProblem: mapGovernProductAttributeApplicabilityActionProblem,
    resolution: 'RECOVER_GOVERN_PRODUCT_ATTRIBUTE_APPLICABILITY',
  },
  { mapProblem: mapGovernVariantAxesActionProblem, resolution: 'RECOVER_GOVERN_VARIANT_AXES' },
  { mapProblem: mapMarkGtinUnresolvedActionProblem, resolution: 'RECOVER_MARK_GTIN_UNRESOLVED' },
  { mapProblem: mapMoveProductCategoryActionProblem, resolution: 'RECOVER_MOVE_PRODUCT_CATEGORY' },
  { mapProblem: mapPromotePackageDefinitionActionProblem, resolution: 'RECOVER_PROMOTE_PACKAGE_DEFINITION' },
  { mapProblem: mapPublishProductConfigurationActionProblem, resolution: 'RECOVER_PUBLISH_PRODUCT_CONFIGURATION' },
  { mapProblem: mapReactivateBrandActionProblem, resolution: 'RECOVER_REACTIVATE_BRAND' },
];

for (const action of actions) {
  describe(action.resolution, () => {
    it('recovers an already committed result without replay', () => {
      const problem = action.mapProblem(
        new ActionAlreadyCommitted({ code: 'action_already_committed', invocationId, reason: 'committed' }),
      );
      expect(problem).toMatchObject({ invocationId, resolution: action.resolution, retryCommand: false, status: 409 });
    });

    it('recovers an uncertain commit before another attempt', () => {
      const problem = action.mapProblem(
        new ActionCommitIndeterminate({ code: 'action_commit_indeterminate', invocationId, reason: 'uncertain' }),
      );
      expect(problem).toMatchObject({ invocationId, resolution: action.resolution, retryCommand: false, status: 503 });
    });

    it('leaves a mismatched payload a plain conflict', () => {
      const problem = action.mapProblem(
        new ActionRequestHashConflict({ code: 'action_request_hash_conflict', reason: 'different payload' }),
      );
      expect(problem).toMatchObject({ status: 409 });
      expect('resolution' in problem).toBe(false);
      expect('invocationId' in problem).toBe(false);
    });
  });
}
