import { ActionAlreadyCommitted, ActionCommitIndeterminate, ActionRequestHashConflict } from '@app/core-runtime';
import { describe, expect, it } from 'effect-rstest';
import { mapCreateProductUnitActionProblem } from '../../api/create-product-unit-action-problems.ts';

const invocationId = '33333333-3333-4333-8333-333333333333';

describe('create-product-unit recovery direction', () => {
  it('directs a committed retry to its exact typed recovery read', () => {
    const problem = mapCreateProductUnitActionProblem(
      new ActionAlreadyCommitted({ code: 'action_already_committed', invocationId, reason: 'committed' }),
    );
    expect(problem).toMatchObject({
      invocationId,
      resolution: 'RECOVER_CREATE_PRODUCT_UNIT',
      retryCommand: false,
      status: 409,
    });
  });

  it('reconciles an uncertain commit before any replay', () => {
    const problem = mapCreateProductUnitActionProblem(
      new ActionCommitIndeterminate({
        code: 'action_commit_indeterminate',
        invocationId,
        reason: 'commit acknowledgement lost',
      }),
    );
    expect(problem).toMatchObject({
      invocationId,
      resolution: 'RECOVER_CREATE_PRODUCT_UNIT',
      retryCommand: false,
      status: 503,
    });
  });

  it('keeps a mismatched idempotency payload as conflict without recovery direction', () => {
    const problem = mapCreateProductUnitActionProblem(
      new ActionRequestHashConflict({ code: 'action_request_hash_conflict', reason: 'different payload' }),
    );
    expect(problem.status).toBe(409);
    expect('resolution' in problem).toBe(false);
    expect('invocationId' in problem).toBe(false);
  });
});
