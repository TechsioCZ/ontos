import { ActionAlreadyCommitted, ActionCommitIndeterminate, ActionRequestHashConflict } from '@app/core-runtime';
import { describe, expect, it } from 'effect-rstest';
import { mapReviseProductTypeActionProblem } from '../../api/revise-product-type-action-problems.ts';
import { mapReviseProductUnitActionProblem } from '../../api/revise-product-unit-action-problems.ts';
import { mapReviseSetCompositionActionProblem } from '../../api/revise-set-composition-action-problems.ts';

const invocationId = '33333333-3333-4333-8333-333333333333';

const cases = [
  {
    action: 'revise product type',
    map: mapReviseProductTypeActionProblem,
    resolution: 'RECOVER_REVISE_PRODUCT_TYPE',
  },
  {
    action: 'revise product unit',
    map: mapReviseProductUnitActionProblem,
    resolution: 'RECOVER_REVISE_PRODUCT_UNIT',
  },
  {
    action: 'revise set composition',
    map: mapReviseSetCompositionActionProblem,
    resolution: 'RECOVER_REVISE_SET_COMPOSITION',
  },
] as const;

describe('revise Action recovery direction', () => {
  for (const { action, map, resolution } of cases) {
    it(`${action} recovers the original committed result`, () => {
      const problem = map(
        new ActionAlreadyCommitted({ code: 'action_already_committed', invocationId, reason: 'committed' }),
      );
      expect(problem).toMatchObject({ invocationId, resolution, retryCommand: false, status: 409 });
    });

    it(`${action} reconciles an uncertain commit before replay`, () => {
      const problem = map(
        new ActionCommitIndeterminate({
          code: 'action_commit_indeterminate',
          invocationId,
          reason: 'commit acknowledgement lost',
        }),
      );
      expect(problem).toMatchObject({ invocationId, resolution, retryCommand: false, status: 503 });
    });

    it(`${action} keeps a mismatched idempotency payload as an ordinary conflict`, () => {
      const problem = map(
        new ActionRequestHashConflict({ code: 'action_request_hash_conflict', reason: 'different payload' }),
      );
      expect(problem.status).toBe(409);
      expect('resolution' in problem).toBe(false);
      expect('invocationId' in problem).toBe(false);
    });
  }
});
