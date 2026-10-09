import { ActionAlreadyCommitted, ActionCommitIndeterminate, ActionRequestHashConflict } from '@app/core-runtime';
import type { ActionCoreError } from '@app/core-runtime';
import { describe, expect, it } from 'effect-rstest';

import { mapRetireBrandActionProblem } from '../../api/retire-brand-action-problems.ts';
import { mapRetireConfigurationUnitActionProblem } from '../../api/retire-configuration-unit-action-problems.ts';
import { mapRetireControlledAttributeValueActionProblem } from '../../api/retire-controlled-attribute-value-action-problems.ts';
import { mapRetireGtinActionProblem } from '../../api/retire-gtin-action-problems.ts';
import { mapRetirePackageDefinitionActionProblem } from '../../api/retire-package-definition-action-problems.ts';

const invocationId = '33333333-3333-4333-8333-333333333333';

const retireActions: readonly {
  readonly mapProblem: (error: ActionCoreError) => object;
  readonly name: string;
  readonly resolution: string;
}[] = [
  { mapProblem: mapRetireBrandActionProblem, name: 'brand', resolution: 'RECOVER_RETIRE_BRAND' },
  {
    mapProblem: mapRetireConfigurationUnitActionProblem,
    name: 'configuration unit',
    resolution: 'RECOVER_RETIRE_CONFIGURATION_UNIT',
  },
  {
    mapProblem: mapRetireControlledAttributeValueActionProblem,
    name: 'controlled attribute value',
    resolution: 'RECOVER_RETIRE_CONTROLLED_ATTRIBUTE_VALUE',
  },
  { mapProblem: mapRetireGtinActionProblem, name: 'GTIN', resolution: 'RECOVER_RETIRE_GTIN' },
  {
    mapProblem: mapRetirePackageDefinitionActionProblem,
    name: 'package definition',
    resolution: 'RECOVER_RETIRE_PACKAGE_DEFINITION',
  },
];

for (const action of retireActions) {
  describe(`retire ${action.name} recovery direction`, () => {
    it('directs a committed retry to the original result without replaying the command', () => {
      const problem = action.mapProblem(
        new ActionAlreadyCommitted({ code: 'action_already_committed', invocationId, reason: 'committed' }),
      );
      expect(problem).toMatchObject({
        invocationId,
        resolution: action.resolution,
        retryCommand: false,
        status: 409,
      });
    });

    it('directs an uncertain commit to authoritative recovery', () => {
      const problem = action.mapProblem(
        new ActionCommitIndeterminate({ code: 'action_commit_indeterminate', invocationId, reason: 'uncertain' }),
      );
      expect(problem).toMatchObject({
        invocationId,
        resolution: action.resolution,
        retryCommand: false,
        status: 503,
      });
    });

    it('keeps a changed payload a conflict without suggesting result recovery', () => {
      const problem = action.mapProblem(
        new ActionRequestHashConflict({ code: 'action_request_hash_conflict', reason: 'different payload' }),
      );
      expect(problem).toMatchObject({ status: 409 });
      expect('resolution' in problem).toBe(false);
      expect('invocationId' in problem).toBe(false);
    });
  });
}
