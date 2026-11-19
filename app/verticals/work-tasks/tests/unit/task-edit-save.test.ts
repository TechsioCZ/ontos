import { ActionProposalAcceptedSchema } from '@app/core-runtime/http/action-proposal';
import { Schema } from 'effect';
import { describe, expect, it } from 'effect-rstest';
import { ApplyCommandActionConflictProblemSchema } from '../../shared/apis/apply-command-action.ts';
import { taskSaveOutcome, taskSaveResult } from '../../src/routes/[lang]/ukoly/task-form-values.ts';

const conflictProblem = (code: 'work_lifecycle_conflict' | 'work_revision_conflict') =>
  Schema.decodeUnknownSync(ApplyCommandActionConflictProblemSchema)({
    _tag: 'ApplyCommandActionConflictProblem',
    code,
    detail: 'Úkoly se mezitím změnily.',
    status: 409,
    title: 'Konflikt',
    type: 'about:blank',
  });

describe('task edit panel save', () => {
  it('turns only a revision conflict into the conflict line; a closed task or an outage is a failure', () => {
    expect(taskSaveOutcome(conflictProblem('work_revision_conflict'))).toBe('conflict');
    expect(taskSaveOutcome(conflictProblem('work_lifecycle_conflict'))).toBe('failed');
    expect(taskSaveOutcome({ _tag: 'ApplyCommandActionUnavailableProblem' })).toBe('failed');
  });

  const proposal = Schema.decodeUnknownSync(ActionProposalAcceptedSchema)({
    _tag: 'ActionProposalAccepted',
    expiresAt: '2026-11-08T12:00:00.000Z',
    proposalId: '10000000-0000-4000-8000-000000000001',
  });

  it('reports a draft parked for approval as proposed; only a committed save moves the revision', () => {
    expect(taskSaveResult(proposal)).toBe('proposed');
    expect(taskSaveResult({ revision: 7 })).toBe(7);
  });
});
