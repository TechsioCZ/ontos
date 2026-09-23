import { ActionAlreadyCommitted, ActionCommitIndeterminate, ActionRequestHashConflict } from '@app/core-runtime';
import { describe, expect, it } from 'effect-rstest';
import { mapCreateSetCompositionActionProblem } from '../../api/create-set-composition-action-problems.ts';

const invocationId = '33333333-3333-4333-8333-333333333333';

describe('create-set-composition recovery direction', () => {
  it('directs a committed retry to its exact typed recovery read', () => {
    const problem = mapCreateSetCompositionActionProblem(
      new ActionAlreadyCommitted({ code: 'action_already_committed', invocationId, reason: 'committed' }),
    );
    expect(problem).toMatchObject({
      invocationId,
      resolution: 'RECOVER_CREATE_SET_COMPOSITION',
      retryCommand: false,
      status: 409,
    });
  });

  it('reconciles an uncertain commit before any replay', () => {
    const problem = mapCreateSetCompositionActionProblem(
      new ActionCommitIndeterminate({
        code: 'action_commit_indeterminate',
        invocationId,
        reason: 'commit acknowledgement lost',
      }),
    );
    expect(problem).toMatchObject({
      invocationId,
      resolution: 'RECOVER_CREATE_SET_COMPOSITION',
      retryCommand: false,
      status: 503,
    });
  });

  it('keeps a mismatched idempotency payload as conflict without recovery direction', () => {
    const problem = mapCreateSetCompositionActionProblem(
      new ActionRequestHashConflict({ code: 'action_request_hash_conflict', reason: 'different payload' }),
    );
    expect(problem.status).toBe(409);
    expect('resolution' in problem).toBe(false);
    expect('invocationId' in problem).toBe(false);
  });
});
