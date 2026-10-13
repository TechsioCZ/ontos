import { Schema } from 'effect';
import { expect, it } from 'effect-rstest';
import { isClosedTaskState } from '../../shared/actions/task-transitions.ts';
import {
  commonTransitionTargets,
  czechCollator,
  filterTasks,
  formatDueDate,
  initialTaskFilters,
  opportunityOptionItems,
} from '../../src/routes/[lang]/siampark/work/tasks-model.ts';
import { EmployeeIdSchema, TaskSchema } from '../../shared/apis/records.ts';
import type { TaskState } from '../../shared/apis/records.ts';

const tenantId = '20000000-0000-4000-8000-000000000001';
const employeeId = Schema.decodeUnknownSync(EmployeeIdSchema)('40000000-0000-4000-8000-000000000001');

const makeTask = (overrides: { readonly dueDate?: string; readonly state?: TaskState; readonly title?: string }) => {
  const encoded = {
    collectionRef: {
      moduleId: 'siampark.work',
      resourceId: 'default',
      resourceType: 'siampark.work.task-collection',
      tenantId,
    },
    contextRefs: [],
    createdAt: '2026-10-01T10:00:00Z',
    priority: 'NORMAL',
    ref: { moduleId: 'siampark.work', resourceId: 'task-1', resourceType: 'siampark.work.task', tenantId },
    state: overrides.state ?? 'NEW',
    title: overrides.title ?? 'Volání zákazníkovi',
    updatedAt: '2026-10-01T10:00:00Z',
  };
  return Schema.decodeUnknownSync(TaskSchema)(
    overrides.dueDate === undefined ? encoded : { ...encoded, dueDate: overrides.dueDate },
  );
};

const today = '2026-10-05';

it('finds a task by its assignee name, folded the same way as titles', () => {
  const assigned = { ...makeTask({}), assigneeEmployeeId: employeeId };
  const employeeNames = new Map([[employeeId, 'Jana Nováková']]);
  const byAssignee = (text: string) =>
    filterTasks([assigned], {
      employeeNames,
      filters: { ...initialTaskFilters, search: text },
      tab: 'all',
    });
  expect(byAssignee('Novák')).toHaveLength(1);
  expect(byAssignee('novak')).toHaveLength(1);
  expect(byAssignee('Dvořák')).toHaveLength(0);
});

it('filters by due date: overdue open tasks, today, and tasks without a date', () => {
  const tasks = [
    makeTask({ dueDate: '2026-10-04', title: 'včera' }),
    makeTask({ dueDate: today, title: 'dnes' }),
    makeTask({ title: 'bez termínu' }),
    makeTask({ dueDate: '2026-10-04', state: 'DONE', title: 'hotovo' }),
  ];
  const titlesFor = (due: 'overdue' | 'today' | 'none' | 'all') =>
    filterTasks(tasks, {
      filters: { ...initialTaskFilters, due },
      tab: 'all',
      today,
    }).map((task) => task.title);
  expect(titlesFor('all')).toHaveLength(4);
  expect(titlesFor('overdue')).toStrictEqual(['včera']);
  expect(titlesFor('today')).toStrictEqual(['dnes']);
  expect(titlesFor('none')).toStrictEqual(['bez termínu']);
});

it('formats due dates as the Termín field shows them', () => {
  expect(formatDueDate('2026-10-31')).toBe('31.10.2026');
  expect(formatDueDate('2026-09-01')).toBe('01.09.2026');
});

it('offers only the state changes every selected task allows', () => {
  expect(commonTransitionTargets([makeTask({ state: 'NEW' })])).toStrictEqual(['IN_PROGRESS', 'CANCELLED']);
  expect(
    commonTransitionTargets([makeTask({ state: 'NEW' }), makeTask({ state: 'IN_PROGRESS', title: 'b' })]),
  ).toStrictEqual(['CANCELLED']);
  expect(commonTransitionTargets([makeTask({ state: 'DONE' })])).toStrictEqual([]);
  expect(commonTransitionTargets([])).toStrictEqual([]);
});

it('treats done and cancelled tasks as closed', () => {
  expect(isClosedTaskState('DONE')).toBe(true);
  expect(isClosedTaskState('CANCELLED')).toBe(true);
  expect(isClosedTaskState('NEW')).toBe(false);
  expect(isClosedTaskState('WAITING')).toBe(false);
});

it('orders Czech text by Czech collation, not by code point', () => {
  // "Č" follows "C" and comes before "D"; "CH" is its own letter after "H"; "Š" follows "S" and "Z" comes last.
  expect(czechCollator.compare('Českobudějovické', 'Děčínská')).toBeLessThan(0);
  expect(czechCollator.compare('Děčínská', 'Chebské')).toBeLessThan(0);
  expect(czechCollator.compare('Chebské', 'Šumperské')).toBeLessThan(0);
  expect(czechCollator.compare('Šumperské', 'Znojemská')).toBeLessThan(0);
});

it("lists the chosen customer's opportunities by folded title and keeps the selected one", () => {
  const opportunities = [
    { id: 'o1', partyId: 'c1', title: 'Síťová infrastruktura' },
    { id: 'o2', partyId: 'c2', title: 'Obnova notebooků' },
    { id: 'o3', partyId: 'c1', title: 'Licence kancelářského balíku' },
  ];
  const values = (partyId: string, query: string, selectedId = '') =>
    opportunityOptionItems(opportunities, { partyId, query, selectedId }).map((item) => item.value);
  expect(values('', '')).toStrictEqual(['o1', 'o2', 'o3']);
  expect(values('c1', '')).toStrictEqual(['o1', 'o3']);
  expect(values('', 'sitova')).toStrictEqual(['o1']);
  expect(values('', 'qqq')).toStrictEqual([]);
  expect(values('c1', '', 'o2')).toStrictEqual(['o1', 'o2', 'o3']);
});
