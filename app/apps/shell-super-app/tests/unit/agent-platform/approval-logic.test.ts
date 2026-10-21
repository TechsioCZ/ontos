import { toContextPermissionAccessObjectId, toModuleAccessObjectId } from '@app/core-runtime';
import { expect, test } from 'effect-rstest';

import {
  approverCheck,
  czechModuleFailure,
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
    [moduleAccess('demo.crm'), moduleAccess('work.tasks'), permission('demo.crm', 'demo.crm.write_all')],
    company,
  );
  expect(sets.access.has('demo.crm')).toBe(true);
  expect(sets.access.has('work.tasks')).toBe(true);
  expect(sets.write.has('demo.crm')).toBe(true);
  expect(sets.write.has('work.tasks')).toBe(false);
});

test('parseCoreKey strips the core prefix and rejects other keys', () => {
  expect(parseCoreKey('core:66666666-6666-4666-8666-66666666666A')).toBe('66666666-6666-4666-8666-66666666666a');
  expect(parseCoreKey('core:')).toBeUndefined();
  expect(parseCoreKey("core:' OR 1=1--")).toBeUndefined();
  expect(parseCoreKey('core:abc')).toBeUndefined();
  expect(parseCoreKey('legacy:crm:x')).toBeUndefined();
});

test('revertBeforeLookup reads the task for work-tasks task updates only', () => {
  const lookup = revertBeforeLookup('work-tasks', { _tag: 'UpdateTask', taskRef: { resourceId: 't1' }, title: 'X' });
  expect(lookup?.query).toEqual({ includeArchived: true, resourceId: 't1' });
  expect(lookup?.pick({ items: [{ ref: { resourceId: 't2' } }, { ref: { resourceId: 't1' }, title: 'A' }] })).toEqual({
    ref: { resourceId: 't1' },
    title: 'A',
  });
  expect(revertBeforeLookup('work-tasks', { _tag: 'CreateTask', title: 'X' })).toBeUndefined();
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
  const lookup = revertBeforeLookup('property-leasing', { _tag: 'SetRentTerms', occupancyRef: { resourceId: 'o1' } });
  expect(lookup?.pick({ occupancies: [occupancy] })).toEqual(occupancy);
  expect(revertBeforeLookup('crm', { _tag: 'UpdateClient' })).toBeUndefined();
});

test('revertResultMessage writes the Czech summary and outcome', () => {
  expect(revertResultMessage({ changed: 0, failed: 0, reverted: 2, unavailable: 0 })).toEqual({
    message: 'Vráceno změn: 2.',
    outcome: 'reverted',
  });
  expect(revertResultMessage({ changed: 0, failed: 0, reverted: 1, unavailable: 1 })).toEqual({
    message: 'Vráceno změn: 1. Nelze automaticky vrátit: 1.',
    outcome: 'partial',
  });
  expect(revertResultMessage({ changed: 0, failed: 1, reverted: 0, unavailable: 0 }).outcome).toBe('failed');
  expect(revertResultMessage({ changed: 0, failed: 0, reverted: 0, unavailable: 0 })).toEqual({
    message: 'V dávce není žádná provedená změna k vrácení.',
    outcome: 'failed',
  });
});

test('revertResultMessage reports records a person changed after the approval', () => {
  expect(revertResultMessage({ changed: 1, failed: 0, reverted: 0, unavailable: 0 })).toEqual({
    message: 'Vráceno změn: 0. Záznam se mezitím změnil, ponecháno beze změny: 1.',
    outcome: 'failed',
  });
  expect(revertResultMessage({ changed: 1, failed: 0, reverted: 1, unavailable: 0 }).outcome).toBe('partial');
});

const clientOfJan = { id: 'c-jan', ownerSalespersonId: 'sp-jan', phone: '+420 541 100 200' };
const crmBody = (viewer: Record<string, unknown>, clients: readonly Record<string, unknown>[]) => ({
  state: { clients: { items: clients } },
  viewer: { assign: false, readAll: false, readAssigned: true, writeAll: false, writeAssigned: true, ...viewer },
});
const updateJansClient = { _tag: 'UpdateClient', id: 'c-jan', patch: { phone: '+420 541 100 299' } };

test('a salesperson cannot see or decide a proposal about a colleague client', () => {
  expect(approverCheck('crm', updateJansClient, crmBody({ salespersonId: 'sp-petra' }, []))).toMatchObject({
    hidden: true,
    ok: false,
  });
  expect(approverCheck('crm', updateJansClient, crmBody({ salespersonId: 'sp-jan' }, [clientOfJan]))).toEqual({
    ok: true,
  });
  expect(
    approverCheck('crm', updateJansClient, crmBody({ readAll: true, salespersonId: 'sp-petra' }, [clientOfJan])),
  ).toMatchObject({ hidden: false, ok: false });
  expect(approverCheck('crm', updateJansClient, crmBody({ writeAll: true }, [clientOfJan]))).toEqual({ ok: true });
});

test('a catalog change needs catalog management, any change needs module write', () => {
  const changePrice = { _tag: 'ChangePrice', id: 'p', priceMinor: 100 };
  expect(approverCheck('merchandise', changePrice, { canManageCatalog: false, canWrite: true })).toMatchObject({
    ok: false,
  });
  expect(approverCheck('merchandise', changePrice, { canManageCatalog: true, canWrite: true })).toEqual({ ok: true });
  expect(approverCheck('tagging', { _tag: 'AttachTag' }, { canWrite: false })).toMatchObject({
    hidden: false,
    ok: false,
  });
  expect(approverCheck('tagging', { _tag: 'AttachTag' }, undefined)).toEqual({ ok: true });
});

test('English framework failures are shown in Czech', () => {
  expect(czechModuleFailure('The requested resource was not found.')).toContain('nebyl nalezen');
  expect(czechModuleFailure('The apply-command Action request is invalid.')).toContain('neplatný');
});

test('CRM client commands read the client before the change', () => {
  const lookup = revertBeforeLookup('crm', updateJansClient);
  expect(lookup?.query).toEqual({ clientId: 'c-jan' });
  expect(lookup?.pick(crmBody({}, [clientOfJan]))).toEqual(clientOfJan);
});
