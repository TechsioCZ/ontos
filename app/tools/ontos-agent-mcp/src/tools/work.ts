import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { labelOf, TASK_STATE_CS } from './labels.ts';
import { applyCommand, CALENDAR_DATE, defineTool, readRecordsOf, readRevision, VERTICAL } from './shared.ts';
import type { TaskWire, WorkCommandResultWire, WorkRecordsWire } from './wire.ts';

export const TASK_STATES = ['NEW', 'IN_PROGRESS', 'WAITING', 'DONE', 'CANCELLED'] as const;
export const TASK_PRIORITIES = ['LOW', 'NORMAL', 'HIGH'] as const;
const OPEN_STATES: ReadonlySet<string> = new Set(['NEW', 'IN_PROGRESS', 'WAITING']);

const idSchema = z.string().min(1).max(300);
const dateSchema = z.string().regex(CALENDAR_DATE, 'Datum ve formátu YYYY-MM-DD');

export const listTasksInput = {
  assigneeEmployeeId: idSchema.optional().describe('Assignee employee id (see list_employees).'),
  overdueOnly: z.boolean().optional().describe('Only open tasks whose due date is before the reference date.'),
  state: z.enum(TASK_STATES).optional().describe('Task state filter.'),
};

export const createTaskInput = {
  assigneeEmployeeId: idSchema.optional().describe('Assignee employee id (see list_employees).'),
  description: z.string().max(2000).optional(),
  dueDate: dateSchema.optional().describe('Due date, YYYY-MM-DD.'),
  opportunityId: idSchema.optional().describe('Linked opportunity id.'),
  partyId: idSchema.optional().describe('Linked customer partyId.'),
  priority: z.enum(TASK_PRIORITIES).optional().describe('LOW, NORMAL or HIGH.'),
  title: z.string().min(1).max(200),
};

export const updateTaskInput = {
  assigneeEmployeeId: idSchema.optional().describe('New assignee employee id.'),
  dueDate: dateSchema.optional().describe('New due date, YYYY-MM-DD.'),
  id: idSchema.describe('Task id (resourceId from list_tasks).'),
  state: z.enum(TASK_STATES).optional().describe('New task state.'),
};

const taskSummary = (task: TaskWire) => ({
  assigneeEmployeeId: task.assigneeEmployeeId ?? null,
  description: task.description ?? null,
  dueDate: task.dueDate ?? null,
  id: task.ref.resourceId,
  opportunityId: task.opportunityId ?? null,
  partyId: task.partyId ?? null,
  priority: task.priority,
  state: task.state,
  stateCs: labelOf(TASK_STATE_CS, task.state),
  title: task.title,
});

export async function listTasks(input: {
  readonly assigneeEmployeeId?: string | undefined;
  readonly overdueOnly?: boolean | undefined;
  readonly state?: (typeof TASK_STATES)[number] | undefined;
}) {
  const response = await readRecordsOf<WorkRecordsWire>(VERTICAL.siamparkWork, {
    ...(input.assigneeEmployeeId === undefined ? {} : { assigneeEmployeeId: input.assigneeEmployeeId }),
    ...(input.state === undefined ? {} : { state: input.state }),
  });
  const items = response.items
    .filter(
      (task) =>
        input.overdueOnly !== true ||
        (OPEN_STATES.has(task.state) && task.dueDate !== undefined && task.dueDate < response.referenceDate),
    )
    .map(taskSummary);
  return {
    count: items.length,
    indicators: { openCount: response.indicators.open, overdueCount: response.indicators.overdue },
    items,
    referenceDate: response.referenceDate,
    revision: response.revision,
  };
}

export async function createTask(input: {
  readonly assigneeEmployeeId?: string | undefined;
  readonly description?: string | undefined;
  readonly dueDate?: string | undefined;
  readonly opportunityId?: string | undefined;
  readonly partyId?: string | undefined;
  readonly priority?: (typeof TASK_PRIORITIES)[number] | undefined;
  readonly title: string;
}) {
  const command = {
    _tag: 'CreateTask',
    title: input.title,
    ...(input.assigneeEmployeeId === undefined ? {} : { assigneeEmployeeId: input.assigneeEmployeeId }),
    ...(input.description === undefined ? {} : { description: input.description }),
    ...(input.dueDate === undefined ? {} : { dueDate: input.dueDate }),
    ...(input.opportunityId === undefined ? {} : { opportunityId: input.opportunityId }),
    ...(input.partyId === undefined ? {} : { partyId: input.partyId }),
    ...(input.priority === undefined ? {} : { priority: input.priority }),
  };
  const result = await applyCommand<WorkCommandResultWire>(VERTICAL.siamparkWork, command, () =>
    readRevision(VERTICAL.siamparkWork),
  );
  return { revision: result.revision, task: result.task === undefined ? null : taskSummary(result.task) };
}

export async function updateTask(input: {
  readonly assigneeEmployeeId?: string | undefined;
  readonly dueDate?: string | undefined;
  readonly id: string;
  readonly state?: (typeof TASK_STATES)[number] | undefined;
}) {
  if (input.state === undefined && input.assigneeEmployeeId === undefined && input.dueDate === undefined) {
    throw new Error('Zadejte state, assigneeEmployeeId nebo dueDate.');
  }
  const query = { resourceId: input.id };
  const current = await readRecordsOf<WorkRecordsWire>(VERTICAL.siamparkWork, query);
  const existing = current.items[0];
  if (existing === undefined) {
    throw new Error(`Úkol ${input.id} nebyl nalezen.`);
  }
  const taskRef = existing.ref;
  const currentRevision = () => readRevision(VERTICAL.siamparkWork, query);

  const changed: string[] = [];
  let revision = current.revision;
  let task: TaskWire | undefined;
  if (input.assigneeEmployeeId !== undefined || input.dueDate !== undefined) {
    const result = await applyCommand<WorkCommandResultWire>(
      VERTICAL.siamparkWork,
      {
        _tag: 'UpdateTask',
        taskRef,
        ...(input.assigneeEmployeeId === undefined ? {} : { assigneeEmployeeId: input.assigneeEmployeeId }),
        ...(input.dueDate === undefined ? {} : { dueDate: input.dueDate }),
      },
      currentRevision,
      revision,
    );
    revision = result.revision;
    task = result.task ?? task;
    if (input.assigneeEmployeeId !== undefined) {
      changed.push('assigneeEmployeeId');
    }
    if (input.dueDate !== undefined) {
      changed.push('dueDate');
    }
  }
  if (input.state !== undefined) {
    const result = await applyCommand<WorkCommandResultWire>(
      VERTICAL.siamparkWork,
      { _tag: 'ChangeTaskState', state: input.state, taskRef },
      currentRevision,
      revision,
    );
    revision = result.revision;
    task = result.task ?? task;
    changed.push('state');
  }
  return { changed, revision, task: task === undefined ? null : taskSummary(task) };
}

export function registerWorkTools(server: McpServer): void {
  defineTool(
    server,
    'list_tasks',
    'List tasks (úkoly) with state, assignee, due date and linked customer or opportunity. Optional assignee, state and overdueOnly filters. Use the returned id for update_task.',
    listTasksInput,
    listTasks,
  );
  defineTool(
    server,
    'create_task',
    'Create a task (úkol). Optional assignee, due date (YYYY-MM-DD), priority and links to a customer or opportunity.',
    createTaskInput,
    createTask,
  );
  defineTool(
    server,
    'update_task',
    'Change a task: state, assignee and/or due date. Each change is a separate apply-command with the current revision.',
    updateTaskInput,
    updateTask,
  );
}
