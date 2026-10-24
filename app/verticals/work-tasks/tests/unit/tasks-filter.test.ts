import { Schema } from 'effect';
import { expect, it } from 'effect-rstest';
import { PartyIdSchema, TaskSchema } from '../../shared/apis/records.ts';
import {
  customerOptionItems,
  defaultTaskTab,
  filterTasks,
  initialTaskFilters,
} from '../../src/routes/[lang]/ukoly/tasks-model.ts';

const tenantId = '20000000-0000-4000-8000-000000000001';

const task = Schema.decodeUnknownSync(TaskSchema)({
  collectionRef: {
    moduleId: 'work.tasks',
    resourceId: 'default',
    resourceType: 'work.tasks.task-collection',
    tenantId,
  },
  contextRefs: [],
  createdAt: '2026-10-05T10:00:00Z',
  priority: 'NORMAL',
  ref: { moduleId: 'work.tasks', resourceId: 'task-1', resourceType: 'work.tasks.task', tenantId },
  state: 'NEW',
  title: 'Úklid skladu před inventurou',
  updatedAt: '2026-10-05T10:00:00Z',
});

it('never expands My tasks to everyone when no work is assigned to the principal', () => {
  expect(filterTasks([task], { filters: initialTaskFilters, tab: 'mine' })).toHaveLength(0);
  expect(filterTasks([task], { filters: initialTaskFilters, tab: 'all' })).toHaveLength(1);
});

it('matches canonical principal ownership across assignment sources', () => {
  const owned = { ...task, ownerPrincipalRef: { principalId: tenantId, tenantId } };
  expect(
    filterTasks([owned, task], {
      filters: initialTaskFilters,
      minePrincipalRef: { principalId: tenantId, tenantId },
      tab: 'mine',
    }),
  ).toStrictEqual([owned]);
  expect(
    filterTasks([owned], {
      filters: initialTaskFilters,
      minePrincipalRef: { principalId: 'someone-else', tenantId },
      tab: 'mine',
    }),
  ).toHaveLength(0);
});

// The "all" tab does not narrow by the current principal.
const search = (text: string) => filterTasks([task], { filters: { ...initialTaskFilters, search: text }, tab: 'all' });

it('finds a task by title without diacritics or case', () => {
  expect(search('uklid sklad')).toHaveLength(1);
  expect(search('PRED INVENTUROU')).toHaveLength(1);
  expect(search('Úklid')).toHaveLength(1);
  expect(search('faktura')).toHaveLength(0);
});

const partyId = Schema.decodeUnknownSync(PartyIdSchema)('30000000-0000-4000-8000-000000000001');
const withCustomer = { ...task, partyId };

it('finds a task by its customer name, folded the same way as titles', () => {
  const customerNames = new Map([[partyId, 'Plzeňské strojírny, s.r.o.']]);
  const byCustomer = (text: string) =>
    filterTasks([withCustomer], {
      customerNames,
      filters: { ...initialTaskFilters, search: text },
      tab: 'all',
    });
  expect(byCustomer('plzenske')).toHaveLength(1);
  expect(byCustomer('STROJIRNY')).toHaveLength(1);
  expect(byCustomer('brno')).toHaveLength(0);
});

it('narrows customer picker items by a query without diacritics and leaves unnamed customers out', () => {
  const customers = [
    { companyId: '12345678', displayName: 'Plzeňské strojírny, s.r.o.', partyId: 'party-1' },
    { companyId: null, displayName: 'Brněnská logistika a.s.', partyId: 'party-2' },
    { companyId: null, displayName: null, partyId: 'party-3' },
  ];
  expect(customerOptionItems(customers, 'plzen')).toStrictEqual([
    { label: 'Plzeňské strojírny, s.r.o.', value: 'party-1' },
  ]);
  expect(customerOptionItems(customers, '')).toHaveLength(2);
  expect(customerOptionItems(customers, 'ostrava')).toHaveLength(0);
});

it('opens available company work when there is no personal open work, without changing explicit mine filtering', () => {
  expect(defaultTaskTab([task], { principalId: tenantId, tenantId })).toBe('all');
  const owned = { ...task, ownerPrincipalRef: { principalId: tenantId, tenantId } };
  expect(defaultTaskTab([task, owned], { principalId: tenantId, tenantId })).toBe('mine');
  expect(defaultTaskTab([{ ...owned, state: 'DONE' }], { principalId: tenantId, tenantId })).toBe('all');
  expect(filterTasks([task], { filters: initialTaskFilters, tab: 'mine' })).toEqual([]);
});
