import { AgentProposalIdSchema } from '@app/shared-contracts/agent-proposals';
import type { AgentCommand } from '@app/shared-contracts/agent-proposals';
import { Schema } from 'effect';
import { expect, it } from 'effect-rstest';

import { reviewTaskProposal, taskDiff, taskRevert, taskStillInPlace } from '../../src/api/agent-review.ts';

const tenantId = 'tenant-1';
const taskRef = { moduleId: 'work.tasks', resourceId: 'T-1', resourceType: 'work.tasks.task', tenantId };
const created = { moduleId: 'work.tasks', resourceId: '$createdId', resourceType: 'work.tasks.task', tenantId };

const review = (
  request: Partial<Parameters<typeof reviewTaskProposal>[0]['request']> & { command: AgentCommand },
  task?: Schema.JsonObject,
  canWrite: boolean | undefined = true,
) =>
  reviewTaskProposal({
    canWrite,
    request: { actionSlug: 'apply-command', key: 'k', stage: 'proposed', ...request },
    task,
    taskRead: task !== undefined,
    tenantId,
  });

it('a new task lists its fields in Czech', () => {
  expect(taskDiff({ _tag: 'CreateTask', dueDate: '2026-10-30', priority: 'HIGH', title: 'Zavolat' })).toEqual([
    { after: '30. 10. 2026', field: 'dueDate', label: 'Termín' },
    { after: 'Vysoká', field: 'priority', label: 'Priorita' },
    { after: 'Zavolat', field: 'title', label: 'Název úkolu' },
  ]);
  expect(taskDiff({ _tag: 'BulkChangeTaskState' })).toBeUndefined();
});

it('CreateTask is undone by cancelling and archiving the created task', () => {
  expect(taskRevert({ _tag: 'CreateTask', title: 'Nový úkol' }, undefined, tenantId)).toEqual({
    commands: [
      { _tag: 'ChangeTaskState', state: 'CANCELLED', taskRef: created },
      { _tag: 'SetTaskArchived', archived: true, taskRef: created },
    ],
    createdIdPath: 'task.ref.resourceId',
    kind: 'commands',
  });
});

it('UpdateTask restores previous fields and nulls a missing dueDate', () => {
  const plan = taskRevert(
    { _tag: 'UpdateTask', dueDate: '2026-11-01', priority: 'HIGH', taskRef, title: 'Nový' },
    { priority: 'LOW', title: 'Starý' },
    tenantId,
  );
  expect(plan).toEqual({
    commands: [{ _tag: 'UpdateTask', dueDate: null, priority: 'LOW', taskRef, title: 'Starý' }],
    kind: 'commands',
  });
  expect(taskRevert({ _tag: 'UpdateTask', taskRef, title: 'Nový' }, undefined, tenantId)).toMatchObject({
    kind: 'none',
  });
});

it('state changes are undone only along allowed transitions', () => {
  expect(taskRevert({ _tag: 'ChangeTaskState', state: 'IN_PROGRESS', taskRef }, { state: 'NEW' }, tenantId)).toEqual({
    kind: 'none',
    reason: 'Úkol nelze vrátit do původního stavu.',
  });
  expect(
    taskRevert({ _tag: 'ChangeTaskState', state: 'WAITING', taskRef }, { state: 'IN_PROGRESS' }, tenantId),
  ).toEqual({ commands: [{ _tag: 'ChangeTaskState', state: 'IN_PROGRESS', taskRef }], kind: 'commands' });
});

it('task updates compare only the fields the command set', () => {
  const command = { _tag: 'UpdateTask', taskRef, title: 'Nový název' };
  expect(taskStillInPlace(command, { description: 'cokoli', title: 'Nový název' })).toBe(true);
  expect(taskStillInPlace(command, { title: 'Ručně přepsáno' })).toBe(false);
  expect(taskStillInPlace({ _tag: 'CreateTask', title: 'X' })).toBeUndefined();
});

it('a pending update shows the live task, its name and its undo plan', () => {
  const item = review({ command: { _tag: 'UpdateTask', taskRef, title: 'Nový' } }, { title: 'Starý' });
  expect(item).toMatchObject({
    diff: [{ after: 'Nový', before: 'Starý', field: 'title', label: 'Název úkolu' }],
    revert: { commands: [{ _tag: 'UpdateTask', taskRef, title: 'Starý' }], kind: 'commands' },
    targetName: 'Starý',
    visible: true,
  });
  expect(item.revertUnavailableReason).toBeUndefined();
});

it('a proposal about a task that is gone for the reader is hidden, a read-only reader is blocked', () => {
  expect(
    reviewTaskProposal({
      canWrite: true,
      request: { actionSlug: 'apply-command', command: { _tag: 'AssignTask', taskRef }, key: 'k', stage: 'proposed' },
      taskRead: true,
      tenantId,
    }).visible,
  ).toBe(false);
  expect(review({ command: { _tag: 'CreateTask', title: 'X' } }, undefined, false).blockedReason).toBe(
    'V tomto modulu nemáte oprávnění k zápisu.',
  );
});

it('an approved change names the proposing agent in a task comment', () => {
  const proposal = {
    agentLabel: 'AI agent B',
    proposalId: Schema.decodeUnknownSync(AgentProposalIdSchema)('p-1'),
    summary: 'Nový úkol',
  };
  expect(review({ command: { _tag: 'CreateTask', title: 'X' }, proposal }).followUp).toEqual({
    commands: [
      {
        _tag: 'AddTaskComment',
        taskRef: created,
        text: 'Změnu „Nový úkol“ navrhl AI agent B; schváleno na stránce Ke schválení.',
      },
    ],
    createdIdPath: 'task.ref.resourceId',
    referenceAudiences: [],
  });
  expect(
    review({ command: { _tag: 'UpdateTask', taskRef, title: 'Y' }, proposal }, { title: 'X' }).followUp,
  ).toMatchObject({ commands: [{ _tag: 'AddTaskComment', taskRef }] });
});

it('undo leaves a change alone when the task was edited since or cannot be read', () => {
  const command = { _tag: 'UpdateTask', taskRef, title: 'Nový' };
  expect(review({ command, stage: 'undo' }, { title: 'Nový' })).toEqual({
    key: 'k',
    stillInPlace: true,
    visible: true,
  });
  expect(review({ command, stage: 'undo' }, { title: 'Jiný' }).stillInPlace).toBe(false);
  expect(review({ command, stage: 'undo' }).visible).toBe(false);
});

it('history shows the command lines without a live before', () => {
  expect(review({ command: { _tag: 'SetTaskArchived', archived: true, taskRef }, stage: 'history' })).toEqual({
    diff: [{ after: 'Ano', field: 'archived', label: 'Archivováno' }],
    key: 'k',
    visible: true,
  });
});
