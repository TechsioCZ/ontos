import { toContextPermissionAccessObjectId, toModuleAccessObjectId } from '@app/core-runtime';
import { expect, test } from 'effect-rstest';

import {
  approverCheck,
  czechModuleFailure,
  hiddenByReview,
  moduleAccessSets,
  parseCoreKey,
  revertResultMessage,
} from '../../../api/agent-platform/approval-logic.ts';
import type { ModuleReview } from '../../../api/agent-platform/module-review.ts';

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

const reviewed = (visible: boolean, blockedReason?: string) => ({
  key: 'p1',
  visible,
  ...(blockedReason === undefined ? {} : { blockedReason }),
});
const ok = (privateRecords: boolean): ModuleReview => ({
  item: () => undefined,
  privateRecords,
  seesAllRecords: false,
  state: 'ok',
});

test('the module review decides whether a proposal is shown', () => {
  expect(hiddenByReview(ok(true), reviewed(false))).toBe(true);
  expect(hiddenByReview(ok(true), reviewed(true))).toBe(false);
  expect(hiddenByReview({ state: 'none' }, undefined)).toBe(false);
  // Modules with private records keep their proposals hidden while their review cannot answer.
  expect(hiddenByReview({ privateRecords: true, state: 'unavailable' }, undefined)).toBe(true);
  expect(hiddenByReview({ privateRecords: false, state: 'unavailable' }, undefined)).toBe(false);
  expect(hiddenByReview(ok(true), undefined)).toBe(true);
});

test('the module review decides who can carry out a proposal', () => {
  expect(approverCheck(ok(true), reviewed(false), undefined)).toMatchObject({ hidden: true, ok: false });
  expect(approverCheck(ok(false), reviewed(true, 'Jen správce katalogu.'), { canWrite: true })).toEqual({
    hidden: false,
    ok: false,
    reason: 'Jen správce katalogu.',
  });
  expect(approverCheck(ok(false), reviewed(true), { canWrite: false })).toEqual({ ok: true });
});

test('modules without a review only block people whose records read says they cannot write', () => {
  expect(approverCheck({ state: 'none' }, undefined, { canWrite: false })).toMatchObject({ hidden: false, ok: false });
  expect(approverCheck({ state: 'none' }, undefined, { canWrite: true })).toEqual({ ok: true });
  expect(approverCheck({ privateRecords: false, state: 'unavailable' }, undefined, undefined)).toEqual({ ok: true });
});

test('English framework failures are shown in Czech', () => {
  expect(czechModuleFailure('The requested resource was not found.')).toContain('nebyl nalezen');
  expect(czechModuleFailure('The apply-command Action request is invalid.')).toContain('neplatný');
});
