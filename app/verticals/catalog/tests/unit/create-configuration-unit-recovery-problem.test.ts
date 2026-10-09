import { ActionAlreadyCommitted, ActionCommitIndeterminate, ActionRequestHashConflict } from '@app/core-runtime';
import { describe, expect, it } from 'effect-rstest';

import { mapCreateConfigurationUnitActionProblem } from '../../api/create-configuration-unit-action-problems.ts';

const invocationId = '33333333-3333-4333-8333-333333333333';

describe('create ConfigurationUnit recovery direction', () => {
  it('directs a committed retry to the original result without replaying the command', () => {
    const problem = mapCreateConfigurationUnitActionProblem(
      new ActionAlreadyCommitted({ code: 'action_already_committed', invocationId, reason: 'committed' }),
    );
    expect(problem).toMatchObject({
      invocationId,
      resolution: 'RECOVER_CREATE_CONFIGURATION_UNIT',
      retryCommand: false,
      status: 409,
    });
  });

  it('directs an uncertain commit to authoritative recovery', () => {
    const problem = mapCreateConfigurationUnitActionProblem(
      new ActionCommitIndeterminate({ code: 'action_commit_indeterminate', invocationId, reason: 'uncertain' }),
    );
    expect(problem).toMatchObject({
      invocationId,
      resolution: 'RECOVER_CREATE_CONFIGURATION_UNIT',
      retryCommand: false,
      status: 503,
    });
  });

  it('keeps a changed payload a conflict without suggesting result recovery', () => {
    const problem = mapCreateConfigurationUnitActionProblem(
      new ActionRequestHashConflict({ code: 'action_request_hash_conflict', reason: 'different payload' }),
    );
    expect(problem.status).toBe(409);
    expect('resolution' in problem).toBe(false);
    expect('invocationId' in problem).toBe(false);
  });
});
