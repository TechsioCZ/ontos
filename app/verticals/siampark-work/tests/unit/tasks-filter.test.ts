import { Schema } from 'effect';
import { expect, it } from 'effect-rstest';
import { TaskSchema } from '../../shared/apis/records.ts';
import { filterTasks, initialTaskFilters } from '../../src/routes/[lang]/siampark/work/tasks-model.ts';

const tenantId = '20000000-0000-4000-8000-000000000001';

const task = Schema.decodeUnknownSync(TaskSchema)({
  collectionRef: {
    moduleId: 'siampark.work',
    resourceId: 'default',
    resourceType: 'siampark.work.task-collection',
    tenantId,
  },
  contextRefs: [],
  createdAt: '2026-10-05T10:00:00Z',
  priority: 'NORMAL',
  ref: { moduleId: 'siampark.work', resourceId: 'task-1', resourceType: 'siampark.work.task', tenantId },
  state: 'NEW',
  title: 'Úklid skladu před inventurou',
  updatedAt: '2026-10-05T10:00:00Z',
});

// The "all" tab ignores whose task it is, so any employee id works here.
const search = (text: string) =>
  filterTasks([task], { filters: { ...initialTaskFilters, search: text }, mineEmployeeId: 'someone-else', tab: 'all' });

it('finds a task by title without diacritics or case', () => {
  expect(search('uklid sklad')).toHaveLength(1);
  expect(search('PRED INVENTUROU')).toHaveLength(1);
  expect(search('Úklid')).toHaveLength(1);
  expect(search('faktura')).toHaveLength(0);
});
