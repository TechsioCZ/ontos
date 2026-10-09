import { ActionAlreadyCommitted, ActionCommitIndeterminate, ActionRequestHashConflict } from '@app/core-runtime';
import { describe, expect, it } from 'effect-rstest';

import { mapCreatePackageDefinitionActionProblem } from '../../api/create-package-definition-action-problems.ts';

const invocationId = '33333333-3333-4333-8333-333333333333';

describe('create PackageDefinition recovery direction', () => {
  it('directs a committed retry to the original result without replaying the command', () => {
    const problem = mapCreatePackageDefinitionActionProblem(
      new ActionAlreadyCommitted({ code: 'action_already_committed', invocationId, reason: 'committed' }),
    );
    expect(problem).toMatchObject({
      invocationId,
      resolution: 'RECOVER_CREATE_PACKAGE_DEFINITION',
      retryCommand: false,
      status: 409,
    });
  });

  it('directs an uncertain commit to authoritative recovery', () => {
    const problem = mapCreatePackageDefinitionActionProblem(
      new ActionCommitIndeterminate({ code: 'action_commit_indeterminate', invocationId, reason: 'uncertain' }),
    );
    expect(problem).toMatchObject({
      invocationId,
      resolution: 'RECOVER_CREATE_PACKAGE_DEFINITION',
      retryCommand: false,
      status: 503,
    });
  });

  it('keeps a changed payload a conflict without suggesting result recovery', () => {
    const problem = mapCreatePackageDefinitionActionProblem(
      new ActionRequestHashConflict({ code: 'action_request_hash_conflict', reason: 'different payload' }),
    );
    expect(problem.status).toBe(409);
    expect('resolution' in problem).toBe(false);
    expect('invocationId' in problem).toBe(false);
  });
});
