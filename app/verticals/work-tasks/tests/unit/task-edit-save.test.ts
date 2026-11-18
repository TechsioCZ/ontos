import { ActionProposalAcceptedSchema } from '@app/core-runtime/http/action-proposal';
import { Schema } from 'effect';
import { describe, expect, it } from 'effect-rstest';
import { ApplyCommandActionConflictProblemSchema } from '../../shared/apis/apply-command-action.ts';
import { TaskSchema } from '../../shared/apis/records.ts';
import {
  initialValues,
  sameFormValues,
  taskSaveOutcome,
  taskSaveResult,
} from '../../src/routes/[lang]/ukoly/task-form-values.ts';

const tenantId = '20000000-0000-4000-8000-000000000001';
const principal = { principalId: '40000000-0000-4000-8000-000000000001', tenantId };
const task = Schema.decodeUnknownSync(TaskSchema)({
  collectionRef: {
    moduleId: 'work.tasks',
    resourceId: 'default',
    resourceType: 'work.tasks.task-collection',
    tenantId,
  },
  contextRefs: [
    {
      moduleId: 'property.portfolio',
      resourceId: '20000000-0000-4000-8000-000000000011',
      resourceType: 'property.portfolio.property',
      tenantId,
    },
    {
      moduleId: 'legal.agreements',
      resourceId: '20000000-0000-4000-8000-000000000012',
      resourceType: 'legal.agreements.contract',
      tenantId,
    },
  ],
  createdAt: '2026-10-05T10:00:00.000Z',
  description: 'Saved description',
  dueDate: '0026-02-12',
  opportunityId: '20000000-0000-4000-8000-000000000021',
  ownerPrincipalRef: principal,
  partyId: '20000000-0000-4000-8000-000000000022',
  plannedHours: 2.5,
  priority: 'HIGH',
  projectId: ' Project / 1 ',
  ref: {
    moduleId: 'work.tasks',
    resourceId: 'task-1',
    resourceType: 'work.tasks.task',
    tenantId,
  },
  state: 'IN_PROGRESS',
  title: 'Saved task',
  updatedAt: '2026-10-05T10:00:00.000Z',
});

const saved = initialValues(task);
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
  it('treats an untouched draft as saved and any edited field as a change', () => {
    expect(sameFormValues(saved, initialValues(task))).toBe(true);
    expect(sameFormValues(saved, { ...saved, title: 'Saved task, revised' })).toBe(false);
    expect(
      sameFormValues(saved, {
        ...saved,
        contextRefs: [...saved.contextRefs.slice(1), ...saved.contextRefs.slice(0, 1)],
      }),
    ).toBe(false);
  });

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
