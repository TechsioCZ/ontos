import { ActionAlreadyCommitted, ActionCommitIndeterminate, ActionRequestHashConflict } from '@app/core-runtime';
import { describe, expect, it } from 'effect-rstest';
import { mapCreateProductCategoryActionProblem } from '../../api/create-product-category-action-problems.ts';

const invocationId = '33333333-3333-4333-8333-333333333333';

describe('create-product-category recovery direction', () => {
  it('directs a committed retry to its exact typed recovery read', () => {
    const problem = mapCreateProductCategoryActionProblem(
      new ActionAlreadyCommitted({ code: 'action_already_committed', invocationId, reason: 'committed' }),
    );
    expect(problem).toMatchObject({
      invocationId,
      resolution: 'RECOVER_CREATE_PRODUCT_CATEGORY',
      retryCommand: false,
      status: 409,
    });
  });

  it('reconciles an uncertain commit before any replay', () => {
    const problem = mapCreateProductCategoryActionProblem(
      new ActionCommitIndeterminate({
        code: 'action_commit_indeterminate',
        invocationId,
        reason: 'commit acknowledgement lost',
      }),
    );
    expect(problem).toMatchObject({
      invocationId,
      resolution: 'RECOVER_CREATE_PRODUCT_CATEGORY',
      retryCommand: false,
      status: 503,
    });
  });

  it('keeps a mismatched idempotency payload as conflict without recovery direction', () => {
    const problem = mapCreateProductCategoryActionProblem(
      new ActionRequestHashConflict({ code: 'action_request_hash_conflict', reason: 'different payload' }),
    );
    expect(problem.status).toBe(409);
    expect('resolution' in problem).toBe(false);
    expect('invocationId' in problem).toBe(false);
  });
});
