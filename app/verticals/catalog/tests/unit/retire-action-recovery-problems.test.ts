import { ActionAlreadyCommitted, ActionCommitIndeterminate, ActionRequestHashConflict } from '@app/core-runtime';
import { describe, expect, it } from 'effect-rstest';

import { mapRetirePackageOptionActionProblem } from '../../api/retire-package-option-action-problems.ts';
import { mapRetireProductCategoryActionProblem } from '../../api/retire-product-category-action-problems.ts';
import { mapRetireProductUnitActionProblem } from '../../api/retire-product-unit-action-problems.ts';
import { mapRetireProductActionProblem } from '../../api/retire-product-action-problems.ts';
import { mapRetireVariantActionProblem } from '../../api/retire-variant-action-problems.ts';

const invocationId = '33333333-3333-4333-8333-333333333333';

describe('retire package-option recovery direction', () => {
  it('directs a committed retry to the immutable result without replaying', () => {
    const problem = mapRetirePackageOptionActionProblem(
      new ActionAlreadyCommitted({ code: 'action_already_committed', invocationId, reason: 'committed' }),
    );
    expect(problem).toMatchObject({
      invocationId,
      resolution: 'RECOVER_RETIRE_PACKAGE_OPTION',
      retryCommand: false,
      status: 409,
    });
  });

  it('directs an uncertain commit to authoritative recovery', () => {
    const problem = mapRetirePackageOptionActionProblem(
      new ActionCommitIndeterminate({ code: 'action_commit_indeterminate', invocationId, reason: 'uncertain' }),
    );
    expect(problem).toMatchObject({
      invocationId,
      resolution: 'RECOVER_RETIRE_PACKAGE_OPTION',
      retryCommand: false,
      status: 503,
    });
  });

  it('keeps a changed payload a plain conflict without recovery direction', () => {
    const problem = mapRetirePackageOptionActionProblem(
      new ActionRequestHashConflict({ code: 'action_request_hash_conflict', reason: 'different payload' }),
    );
    expect(problem.status).toBe(409);
    expect('resolution' in problem).toBe(false);
    expect('invocationId' in problem).toBe(false);
  });
});

describe('retire product-category recovery direction', () => {
  it('directs a committed retry to the immutable result without replaying', () => {
    const problem = mapRetireProductCategoryActionProblem(
      new ActionAlreadyCommitted({ code: 'action_already_committed', invocationId, reason: 'committed' }),
    );
    expect(problem).toMatchObject({
      invocationId,
      resolution: 'RECOVER_RETIRE_PRODUCT_CATEGORY',
      retryCommand: false,
      status: 409,
    });
  });

  it('directs an uncertain commit to authoritative recovery', () => {
    const problem = mapRetireProductCategoryActionProblem(
      new ActionCommitIndeterminate({ code: 'action_commit_indeterminate', invocationId, reason: 'uncertain' }),
    );
    expect(problem).toMatchObject({
      invocationId,
      resolution: 'RECOVER_RETIRE_PRODUCT_CATEGORY',
      retryCommand: false,
      status: 503,
    });
  });

  it('keeps a changed payload a plain conflict without recovery direction', () => {
    const problem = mapRetireProductCategoryActionProblem(
      new ActionRequestHashConflict({ code: 'action_request_hash_conflict', reason: 'different payload' }),
    );
    expect(problem.status).toBe(409);
    expect('resolution' in problem).toBe(false);
    expect('invocationId' in problem).toBe(false);
  });
});

describe('retire product-unit recovery direction', () => {
  it('directs a committed retry to the immutable result without replaying', () => {
    const problem = mapRetireProductUnitActionProblem(
      new ActionAlreadyCommitted({ code: 'action_already_committed', invocationId, reason: 'committed' }),
    );
    expect(problem).toMatchObject({
      invocationId,
      resolution: 'RECOVER_RETIRE_PRODUCT_UNIT',
      retryCommand: false,
      status: 409,
    });
  });

  it('directs an uncertain commit to authoritative recovery', () => {
    const problem = mapRetireProductUnitActionProblem(
      new ActionCommitIndeterminate({ code: 'action_commit_indeterminate', invocationId, reason: 'uncertain' }),
    );
    expect(problem).toMatchObject({
      invocationId,
      resolution: 'RECOVER_RETIRE_PRODUCT_UNIT',
      retryCommand: false,
      status: 503,
    });
  });

  it('keeps a changed payload a plain conflict without recovery direction', () => {
    const problem = mapRetireProductUnitActionProblem(
      new ActionRequestHashConflict({ code: 'action_request_hash_conflict', reason: 'different payload' }),
    );
    expect(problem.status).toBe(409);
    expect('resolution' in problem).toBe(false);
    expect('invocationId' in problem).toBe(false);
  });
});

describe('retire product recovery direction', () => {
  it('directs a committed retry to the immutable result without replaying', () => {
    const problem = mapRetireProductActionProblem(
      new ActionAlreadyCommitted({ code: 'action_already_committed', invocationId, reason: 'committed' }),
    );
    expect(problem).toMatchObject({
      invocationId,
      resolution: 'RECOVER_RETIRE_PRODUCT',
      retryCommand: false,
      status: 409,
    });
  });

  it('directs an uncertain commit to authoritative recovery', () => {
    const problem = mapRetireProductActionProblem(
      new ActionCommitIndeterminate({ code: 'action_commit_indeterminate', invocationId, reason: 'uncertain' }),
    );
    expect(problem).toMatchObject({
      invocationId,
      resolution: 'RECOVER_RETIRE_PRODUCT',
      retryCommand: false,
      status: 503,
    });
  });

  it('keeps a changed payload a plain conflict without recovery direction', () => {
    const problem = mapRetireProductActionProblem(
      new ActionRequestHashConflict({ code: 'action_request_hash_conflict', reason: 'different payload' }),
    );
    expect(problem.status).toBe(409);
    expect('resolution' in problem).toBe(false);
    expect('invocationId' in problem).toBe(false);
  });
});

describe('retire variant recovery direction', () => {
  it('directs a committed retry to the immutable result without replaying', () => {
    const problem = mapRetireVariantActionProblem(
      new ActionAlreadyCommitted({ code: 'action_already_committed', invocationId, reason: 'committed' }),
    );
    expect(problem).toMatchObject({
      invocationId,
      resolution: 'RECOVER_RETIRE_VARIANT',
      retryCommand: false,
      status: 409,
    });
  });

  it('directs an uncertain commit to authoritative recovery', () => {
    const problem = mapRetireVariantActionProblem(
      new ActionCommitIndeterminate({ code: 'action_commit_indeterminate', invocationId, reason: 'uncertain' }),
    );
    expect(problem).toMatchObject({
      invocationId,
      resolution: 'RECOVER_RETIRE_VARIANT',
      retryCommand: false,
      status: 503,
    });
  });

  it('keeps a changed payload a plain conflict without recovery direction', () => {
    const problem = mapRetireVariantActionProblem(
      new ActionRequestHashConflict({ code: 'action_request_hash_conflict', reason: 'different payload' }),
    );
    expect(problem.status).toBe(409);
    expect('resolution' in problem).toBe(false);
    expect('invocationId' in problem).toBe(false);
  });
});
