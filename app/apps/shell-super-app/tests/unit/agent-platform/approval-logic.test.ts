import { toContextPermissionAccessObjectId, toModuleAccessObjectId } from '@app/core-runtime';
import { expect, test } from 'effect-rstest';

import {
  moduleAccessSets,
  parseCoreKey,
  revertBeforeLookup,
  revertResultMessage,
} from '../../../api/agent-platform/approval-logic.ts';

const tenant = '70000000-0000-4000-8000-000000000020';
const company = '71000000-0000-4000-8000-000000000020';
const moduleAccess = (moduleId: string) => ({
  relation: 'accessor',
  resourceId: toModuleAccessObjectId(tenant, company, moduleId) ?? '',
  resourceType: 'module_access',
});
const permission = (moduleId: string, value: string) => ({
  relation: 'grantee',
  resourceId: toContextPermissionAccessObjectId(tenant, company, { moduleId, permission: value }) ?? '',
  resourceType: 'context_permission',
});

test('moduleAccessSets separates open access from write permission', () => {
  const sets = moduleAccessSets(
    [moduleAccess('demo.crm'), moduleAccess('siampark.work'), permission('demo.crm', 'demo.crm.write_all')],
    company,
  );
  expect(sets.access.has('demo.crm')).toBe(true);
  expect(sets.access.has('siampark.work')).toBe(true);
  expect(sets.write.has('demo.crm')).toBe(true);
  expect(sets.write.has('siampark.work')).toBe(false);
});

test('parseCoreKey strips the core prefix and rejects other keys', () => {
  expect(parseCoreKey('core:abc')).toBe('abc');
  expect(parseCoreKey('core:')).toBeUndefined();
  expect(parseCoreKey('legacy:crm:x')).toBeUndefined();
});

test('revertBeforeLookup reads the task for siampark-work task updates only', () => {
  const lookup = revertBeforeLookup('siampark-work', { _tag: 'UpdateTask', taskRef: { resourceId: 't1' }, title: 'X' });
  expect(lookup?.query).toEqual({ includeArchived: true, resourceId: 't1' });
  expect(lookup?.pick({ items: [{ ref: { resourceId: 't2' } }, { ref: { resourceId: 't1' }, title: 'A' }] })).toEqual({
    ref: { resourceId: 't1' },
    title: 'A',
  });
  expect(revertBeforeLookup('siampark-work', { _tag: 'CreateTask', title: 'X' })).toBeUndefined();
});

test('revertBeforeLookup reads the product for merchandise price changes', () => {
  const lookup = revertBeforeLookup('merchandise', { _tag: 'ChangePrice', id: 'p1', priceMinor: 100 });
  expect(lookup?.query).toEqual({ view: { productId: 'p1' } });
  expect(lookup?.pick({ products: [{ id: 'p1', currentPriceMinor: 90 }] })).toEqual({
    id: 'p1',
    currentPriceMinor: 90,
  });
});

test('revertBeforeLookup reads the occupancy for rent term changes', () => {
  const occupancy = { occupancyRef: { resourceId: 'o1' }, startDate: '2026-01-01' };
  const lookup = revertBeforeLookup('siampark-occupancy', { _tag: 'SetRentTerms', occupancyRef: { resourceId: 'o1' } });
  expect(lookup?.pick({ occupancies: [occupancy] })).toEqual(occupancy);
  expect(revertBeforeLookup('crm', { _tag: 'UpdateClient' })).toBeUndefined();
});

test('revertResultMessage writes the Czech summary and outcome', () => {
  expect(revertResultMessage({ failed: 0, reverted: 2, unavailable: 0 })).toEqual({
    message: 'Vráceno změn: 2.',
    outcome: 'reverted',
  });
  expect(revertResultMessage({ failed: 0, reverted: 1, unavailable: 1 })).toEqual({
    message: 'Vráceno změn: 1. Nelze automaticky vrátit: 1.',
    outcome: 'partial',
  });
  expect(revertResultMessage({ failed: 1, reverted: 0, unavailable: 0 }).outcome).toBe('failed');
  expect(revertResultMessage({ failed: 0, reverted: 0, unavailable: 0 })).toEqual({
    message: 'V dávce není žádná provedená změna k vrácení.',
    outcome: 'failed',
  });
});
