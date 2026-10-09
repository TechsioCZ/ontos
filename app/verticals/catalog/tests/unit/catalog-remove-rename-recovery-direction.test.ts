import { ActionAlreadyCommitted, ActionCommitIndeterminate, ActionRequestHashConflict } from '@app/core-runtime';
import type { ActionCoreError } from '@app/core-runtime';
import { describe, expect, it } from 'effect-rstest';

import { mapRemoveProductManufacturerActionProblem } from '../../api/remove-product-manufacturer-action-problems.ts';
import { mapRemoveProductRelationshipActionProblem } from '../../api/remove-product-relationship-action-problems.ts';
import { mapRemoveVariantAttributeOverrideActionProblem } from '../../api/remove-variant-attribute-override-action-problems.ts';
import { mapRemoveVariantLocalizedFactsActionProblem } from '../../api/remove-variant-localized-facts-action-problems.ts';
import { mapRenameAttributeDefinitionActionProblem } from '../../api/rename-attribute-definition-action-problems.ts';
import { mapRenameBrandActionProblem } from '../../api/rename-brand-action-problems.ts';
import { mapRenameControlledAttributeValueActionProblem } from '../../api/rename-controlled-attribute-value-action-problems.ts';

const invocationId = '33333333-3333-4333-8333-333333333333';

const actions: readonly {
  readonly mapProblem: (error: ActionCoreError) => object;
  readonly name: string;
  readonly resolution: string;
}[] = [
  {
    mapProblem: mapRemoveProductManufacturerActionProblem,
    name: 'remove-product-manufacturer',
    resolution: 'RECOVER_REMOVE_PRODUCT_MANUFACTURER',
  },
  {
    mapProblem: mapRemoveProductRelationshipActionProblem,
    name: 'remove-product-relationship',
    resolution: 'RECOVER_REMOVE_PRODUCT_RELATIONSHIP',
  },
  {
    mapProblem: mapRemoveVariantAttributeOverrideActionProblem,
    name: 'remove-variant-attribute-override',
    resolution: 'RECOVER_REMOVE_VARIANT_ATTRIBUTE_OVERRIDE',
  },
  {
    mapProblem: mapRemoveVariantLocalizedFactsActionProblem,
    name: 'remove-variant-localized-facts',
    resolution: 'RECOVER_REMOVE_VARIANT_LOCALIZED_FACTS',
  },
  {
    mapProblem: mapRenameAttributeDefinitionActionProblem,
    name: 'rename-attribute-definition',
    resolution: 'RECOVER_RENAME_ATTRIBUTE_DEFINITION',
  },
  { mapProblem: mapRenameBrandActionProblem, name: 'rename-brand', resolution: 'RECOVER_RENAME_BRAND' },
  {
    mapProblem: mapRenameControlledAttributeValueActionProblem,
    name: 'rename-controlled-attribute-value',
    resolution: 'RECOVER_RENAME_CONTROLLED_ATTRIBUTE_VALUE',
  },
];

for (const action of actions) {
  describe(`${action.name} recovery direction`, () => {
    it('directs a committed retry to the original result without replaying', () => {
      const problem = action.mapProblem(
        new ActionAlreadyCommitted({ code: 'action_already_committed', invocationId, reason: 'committed' }),
      );
      expect(problem).toMatchObject({ invocationId, resolution: action.resolution, retryCommand: false, status: 409 });
    });

    it('directs an uncertain commit to authoritative recovery', () => {
      const problem = action.mapProblem(
        new ActionCommitIndeterminate({ code: 'action_commit_indeterminate', invocationId, reason: 'uncertain' }),
      );
      expect(problem).toMatchObject({ invocationId, resolution: action.resolution, retryCommand: false, status: 503 });
    });

    it('keeps a mismatched payload a plain conflict', () => {
      const problem = action.mapProblem(
        new ActionRequestHashConflict({ code: 'action_request_hash_conflict', reason: 'different payload' }),
      );
      expect(problem).toMatchObject({ status: 409 });
      expect('resolution' in problem).toBe(false);
      expect('invocationId' in problem).toBe(false);
    });
  });
}
