import { expect, it } from 'effect-rstest';

import type { AgentCommand, AgentRevertPlan } from '../../src/agent-proposals.ts';
import { buildAgentRevertPlan, resolveAgentRevertPlan } from '../../src/agent-revert.ts';

const tenantId = 'tenant-1';
const taskRef = { moduleId: 'siampark.work', resourceId: 'T-1', resourceType: 'siampark.work.task', tenantId };

const build = (appId: string, command: AgentCommand, before?: Record<string, unknown>): AgentRevertPlan =>
  buildAgentRevertPlan(appId, before === undefined ? { command, tenantId } : { before, command, tenantId });

const commandsOf = (plan: AgentRevertPlan): readonly AgentCommand[] => {
  if (plan.kind !== 'commands') throw new Error(`expected commands plan, got ${plan.kind}`);
  return plan.commands;
};

it('CreateTask plans cancel and archive of the created task', () => {
  const plan = build('siampark-work', { _tag: 'CreateTask', title: 'Nový úkol' });
  expect(commandsOf(plan)).toHaveLength(2);
  expect(plan).toMatchObject({ createdIdPath: 'task.ref.resourceId', kind: 'commands' });
});

it('resolving CreateTask replaces the created id and drops createdIdPath', () => {
  const plan = build('siampark-work', { _tag: 'CreateTask', title: 'Nový úkol' });
  const resolved = resolveAgentRevertPlan(plan, { task: { ref: { resourceId: 'T-9' } } });
  const created = { moduleId: 'siampark.work', resourceId: 'T-9', resourceType: 'siampark.work.task', tenantId };
  expect(resolved).toEqual({
    commands: [
      { _tag: 'ChangeTaskState', state: 'CANCELLED', taskRef: created },
      { _tag: 'SetTaskArchived', archived: true, taskRef: created },
    ],
    kind: 'commands',
  });
});

it('UpdateTask restores previous fields and nulls a missing dueDate', () => {
  const plan = build(
    'siampark-work',
    { _tag: 'UpdateTask', taskRef, title: 'Nový', priority: 'HIGH', dueDate: '2026-11-01' },
    { title: 'Starý', priority: 'LOW' },
  );
  expect(commandsOf(plan)).toEqual([
    { _tag: 'UpdateTask', taskRef, title: 'Starý', priority: 'LOW', dueDate: null },
  ]);
});

it('UpdateTask without before is not revertible', () => {
  expect(build('siampark-work', { _tag: 'UpdateTask', taskRef, title: 'Nový' })).toEqual({
    kind: 'none',
    reason: 'Chybí původní hodnoty, změnu nelze automaticky vrátit.',
  });
});

it('ChangeTaskState IN_PROGRESS back to NEW is an illegal transition', () => {
  expect(build('siampark-work', { _tag: 'ChangeTaskState', state: 'IN_PROGRESS', taskRef }, { state: 'NEW' })).toEqual({
    kind: 'none',
    reason: 'Úkol nelze vrátit do původního stavu.',
  });
});

it('ChangeTaskState WAITING back to IN_PROGRESS is legal', () => {
  expect(commandsOf(build('siampark-work', { _tag: 'ChangeTaskState', state: 'WAITING', taskRef }, { state: 'IN_PROGRESS' }))).toEqual([
    { _tag: 'ChangeTaskState', state: 'IN_PROGRESS', taskRef },
  ]);
});

it('ChangePrice without variant restores currentPriceMinor', () => {
  const plan = build(
    'merchandise',
    { _tag: 'ChangePrice', id: 'P1', priceMinor: 14900 },
    { currentPriceMinor: 12900 },
  );
  expect(commandsOf(plan)).toEqual([{ _tag: 'ChangePrice', id: 'P1', priceMinor: 12900 }]);
});

it('ChangePrice with variantId restores that variant priceMinor', () => {
  const plan = build(
    'merchandise',
    { _tag: 'ChangePrice', id: 'P1', priceMinor: 3000, variantId: 'V2' },
    {
      currentPriceMinor: 1000,
      variants: [
        { id: 'V1', priceMinor: 1000 },
        { id: 'V2', priceMinor: 2000 },
      ],
    },
  );
  expect(commandsOf(plan)).toEqual([{ _tag: 'ChangePrice', id: 'P1', priceMinor: 2000, variantId: 'V2' }]);
});

it('UpdateProduct with a patch key missing from before is not revertible', () => {
  expect(
    build('merchandise', { _tag: 'UpdateProduct', id: 'P1', patch: { name: 'B', price: 5 } }, { name: 'A' }),
  ).toEqual({ kind: 'none', reason: 'Chybí původní hodnoty, změnu nelze automaticky vrátit.' });
});

it('CreateDraft cancel is filled with the created occupancy id', () => {
  const plan = build('siampark-occupancy', { _tag: 'CreateDraft' });
  const resolved = resolveAgentRevertPlan(plan, { resourceRef: { resourceId: 'O-1' } });
  expect(resolved).toEqual({
    commands: [
      {
        _tag: 'Cancel',
        occupancyRef: { moduleId: 'siampark.occupancy', resourceId: 'O-1', resourceType: 'siampark.occupancy.occupancy', tenantId },
      },
    ],
    kind: 'commands',
  });
});

it('occupancy state changes are not automatically revertible', () => {
  expect(build('siampark-occupancy', { _tag: 'Confirm', occupancyRef: taskRef })).toEqual({
    kind: 'none',
    reason: 'Změnu stavu nájmu nelze automaticky vrátit.',
  });
});

it('unknown app ids are not revertible', () => {
  expect(build('tagging', { _tag: 'ApplyTag' })).toEqual({
    kind: 'none',
    reason: 'Tuto změnu nelze automaticky vrátit.',
  });
});

it('resolving without the created id is not revertible', () => {
  const plan = build('siampark-work', { _tag: 'CreateTask', title: 'Nový úkol' });
  expect(resolveAgentRevertPlan(plan, { task: {} })).toEqual({
    kind: 'none',
    reason: 'Nepodařilo se zjistit nově založený záznam, změnu nelze automaticky vrátit.',
  });
});
