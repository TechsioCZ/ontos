import { ActionAlreadyCommitted, ActionCommitIndeterminate, ActionRequestHashConflict } from '@app/core-runtime';
import type { ActionCoreError } from '@app/core-runtime';
import { describe, expect, it } from 'effect-rstest';
import { mapSetProductManufacturerActionProblem } from '../../api/set-product-manufacturer-action-problems.ts';
import { mapSetProductTypeActionProblem } from '../../api/set-product-type-action-problems.ts';
import { mapSetProductUnitTargetDivisibilityActionProblem } from '../../api/set-product-unit-target-divisibility-action-problems.ts';
import { mapSetVariantAttributeOverrideActionProblem } from '../../api/set-variant-attribute-override-action-problems.ts';
import { mapSetVariantLocalizedFactsActionProblem } from '../../api/set-variant-localized-facts-action-problems.ts';

const invocationId = '33333333-3333-4333-8333-333333333333';

const cases: readonly {
  readonly action: string;
  readonly map: (error: ActionCoreError) => { readonly status: number };
  readonly resolution: string;
}[] = [
  {
    action: 'set product manufacturer',
    map: mapSetProductManufacturerActionProblem,
    resolution: 'RECOVER_SET_PRODUCT_MANUFACTURER',
  },
  { action: 'set product type', map: mapSetProductTypeActionProblem, resolution: 'RECOVER_SET_PRODUCT_TYPE' },
  {
    action: 'set product unit target divisibility',
    map: mapSetProductUnitTargetDivisibilityActionProblem,
    resolution: 'RECOVER_SET_PRODUCT_UNIT_TARGET_DIVISIBILITY',
  },
  {
    action: 'set variant attribute override',
    map: mapSetVariantAttributeOverrideActionProblem,
    resolution: 'RECOVER_SET_VARIANT_ATTRIBUTE_OVERRIDE',
  },
  {
    action: 'set variant localized facts',
    map: mapSetVariantLocalizedFactsActionProblem,
    resolution: 'RECOVER_SET_VARIANT_LOCALIZED_FACTS',
  },
];

describe('Set Action-specific recovery direction', () => {
  for (const { action, map, resolution } of cases) {
    it(`${action} recovers the committed result by invocation`, () => {
      const problem = map(
        new ActionAlreadyCommitted({ code: 'action_already_committed', invocationId, reason: 'committed' }),
      );
      expect(problem).toMatchObject({ invocationId, resolution, retryCommand: false, status: 409 });
    });

    it(`${action} recovers an uncertain commit before replay`, () => {
      const problem = map(
        new ActionCommitIndeterminate({ code: 'action_commit_indeterminate', invocationId, reason: 'uncertain' }),
      );
      expect(problem).toMatchObject({ invocationId, resolution, retryCommand: false, status: 503 });
    });

    it(`${action} leaves mismatched payloads as plain conflicts`, () => {
      const problem = map(
        new ActionRequestHashConflict({ code: 'action_request_hash_conflict', reason: 'different payload' }),
      );
      expect(problem.status).toBe(409);
      expect('resolution' in problem).toBe(false);
      expect('invocationId' in problem).toBe(false);
    });
  }
});
