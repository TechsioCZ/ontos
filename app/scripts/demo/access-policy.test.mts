import { Result, Schema } from 'effect';
import { expect, it } from 'effect-rstest';

import { CatalogSnapshotEntrySchema } from '../../packages/core-runtime/src/access/model.ts';
import type { CatalogSnapshotEntry } from '../../packages/core-runtime/src/access/model.ts';
import { CapabilityKeySchema, ModuleKeySchema } from '../../packages/core-runtime/src/access/ids.ts';
import { PROPOSAL_REVIEW_CAPABILITY, policyRoleCells, policyRoleKeys } from './access-policy.mts';
import type { PolicyRole } from './access-policy.mts';

const applyCommandKey = 'demo.crm.apply-command';
const counterpartyReadKey = 'demo.crm.counterparty.read';
const salaryReadKey = 'demo.crm.party.field.salary';
const eraseKey = 'demo.crm.party.erase';
const mergeKey = 'demo.crm.party.merge';

const entry = (key: string, overrides: Partial<CatalogSnapshotEntry> = {}): CatalogSnapshotEntry =>
  Schema.decodeUnknownSync(CatalogSnapshotEntrySchema)({
    key,
    kind: 'action',
    modes: ['run'],
    moduleKey: key.split('.').slice(0, 2).join('.'),
    placement: { group: 'records', level: 'basic' },
    risk: 'routine',
    selectors: [],
    ...overrides,
  });

const catalog: readonly CatalogSnapshotEntry[] = [
  entry(applyCommandKey),
  entry(counterpartyReadKey, { kind: 'read', modes: ['run'] }),
  entry(salaryReadKey, {
    fieldClass: 'salaries',
    kind: 'field_read',
    modes: ['run'],
    parentKey: CapabilityKeySchema.make(counterpartyReadKey),
    risk: 'sensitive',
  }),
  entry(mergeKey, { modes: ['run', 'propose'], risk: 'critical' }),
  entry(eraseKey, { modes: ['run', 'propose', 'approve'], risk: 'critical' }),
  entry(PROPOSAL_REVIEW_CAPABILITY, {
    modes: ['run', 'propose', 'approve'],
    moduleKey: ModuleKeySchema.make('core.identity'),
    risk: 'sensitive',
  }),
  entry('work.tasks.apply-command', { moduleKey: ModuleKeySchema.make('work.tasks') }),
];

const keysOf = (cells: readonly { readonly capabilityKey: string }[]) =>
  [...new Set(cells.map(({ capabilityKey }) => capabilityKey))].toSorted();

it('a read role reaches only the read capabilities of its module', () => {
  const role: PolicyRole = { label: 'Reader', modules: { 'demo.crm': 'read' } };
  const compiled = policyRoleCells(role, catalog);
  expect(Result.isSuccess(compiled)).toBe(true);
  if (Result.isSuccess(compiled)) {
    expect(keysOf(compiled.success)).toEqual([counterpartyReadKey, salaryReadKey]);
  }
});

it('a write role reaches every capability the module declares', () => {
  const role: PolicyRole = { label: 'Writer', modules: { 'demo.crm': 'write' } };
  const compiled = policyRoleCells(role, catalog);
  expect(Result.isSuccess(compiled)).toBe(true);
  if (Result.isSuccess(compiled)) {
    expect(keysOf(compiled.success)).toEqual([applyCommandKey, counterpartyReadKey, eraseKey, salaryReadKey, mergeKey]);
  }
});

it('a restricted module grants only the capabilities the role names', () => {
  const role: PolicyRole = {
    capabilityKeys: { 'demo.crm': [counterpartyReadKey] },
    label: 'Restricted',
    modules: { 'demo.crm': 'write' },
    restrictedModules: ['demo.crm'],
  };
  expect(policyRoleKeys(role, catalog)).toEqual([counterpartyReadKey]);
});

const modesOf = (role: PolicyRole, key: string) => {
  const compiled = policyRoleCells(role, catalog);
  if (Result.isFailure(compiled)) {
    throw new Error(compiled.failure);
  }
  return compiled.success
    .filter((cell) => cell.capabilityKey === key)
    .map((cell) => cell.mode)
    .toSorted();
};

it('a human runs and proposes; only a proposal reviewer approves', () => {
  const writer: PolicyRole = { label: 'Writer', modules: { 'demo.crm': 'write' } };
  const reviewer: PolicyRole = { label: 'Reviewer', modules: { 'demo.crm': 'write' }, proposalReview: true };
  expect(modesOf(writer, eraseKey)).toEqual(['propose', 'run']);
  expect(modesOf(reviewer, eraseKey)).toEqual(['approve', 'propose', 'run']);
  // A reviewer also reaches the one reviewed proposal capability at its declared approve mode.
  expect(modesOf(reviewer, PROPOSAL_REVIEW_CAPABILITY)).toEqual(['approve', 'propose', 'run']);
});

it('an agent proposes the sensitive and critical work and runs only the routine', () => {
  const role: PolicyRole = { label: 'Agent', modules: { 'demo.crm': 'write' } };
  const compiled = policyRoleCells(role, catalog, 'agent');
  expect(Result.isSuccess(compiled)).toBe(true);
  if (Result.isSuccess(compiled)) {
    const modes = (key: string) =>
      compiled.success.filter((cell) => cell.capabilityKey === key).map((cell) => cell.mode);
    expect(modes(applyCommandKey)).toEqual(['run']);
    expect(modes(mergeKey)).toEqual(['propose']);
    expect(modes(salaryReadKey)).toEqual([]);
  }
});

it('refuses a reviewed key the pinned release does not declare', () => {
  const role: PolicyRole = {
    capabilityKeys: { 'demo.crm': ['demo.crm.retired.thing'] },
    label: 'Stale',
    modules: { 'demo.crm': 'read' },
    restrictedModules: ['demo.crm'],
  };
  const compiled = policyRoleCells(role, catalog);
  expect(Result.isFailure(compiled)).toBe(true);
  if (Result.isFailure(compiled)) {
    expect(compiled.failure).toContain('demo.crm.retired.thing');
  }
});

it('grants scope-wide where declared and the narrowest selector otherwise', () => {
  const scoped: readonly CatalogSnapshotEntry[] = [
    entry('demo.crm.party.list', { kind: 'read', selectors: ['assigned', 'entrusted'] }),
    entry('demo.crm.party.get', { kind: 'read', selectors: ['all', 'assigned'] }),
  ];
  const compiled = policyRoleCells({ label: 'Reader', modules: { 'demo.crm': 'read' } }, scoped);
  expect(Result.isSuccess(compiled)).toBe(true);
  if (Result.isSuccess(compiled)) {
    expect(compiled.success.find((cell) => cell.capabilityKey === 'demo.crm.party.list')?.selector).toEqual({
      _tag: 'assigned',
    });
    expect(compiled.success.find((cell) => cell.capabilityKey === 'demo.crm.party.get')?.selector).toEqual({
      _tag: 'all',
    });
  }
});

it('replaces a module-derived all cell with the explicit key selector instead of unioning both', () => {
  const read = entry('demo.crm.api-records.read', { kind: 'read', selectors: ['all', 'assigned', 'entrusted'] });
  for (const selector of ['assigned', 'entrusted'] as const) {
    const compiled = policyRoleCells(
      {
        capabilityKeys: { 'demo.crm': [read.key] },
        capabilitySelectors: { [read.key]: selector },
        label: 'Narrowed',
        modules: { 'demo.crm': 'read' },
      },
      [read],
    );
    expect(Result.isSuccess(compiled)).toBe(true);
    if (Result.isSuccess(compiled)) {
      expect(compiled.success).toEqual([{ capabilityKey: read.key, mode: 'run', selector: { _tag: selector } }]);
    }
  }
});

it('refuses an undeclared selector, an unknown key, and a selector on a scope-wide capability', () => {
  const read = entry('demo.crm.api-records.read', { kind: 'read', selectors: ['all', 'assigned'] });
  const selectorCases: NonNullable<PolicyRole['capabilitySelectors']>[] = [
    { [read.key]: 'entrusted' as const },
    { 'demo.crm.unknown.read': 'assigned' as const },
    { applyCommandKey: 'assigned' as const },
  ];
  for (const capabilitySelectors of selectorCases) {
    expect(
      Result.isFailure(
        policyRoleCells({ capabilitySelectors, label: 'Invalid selector', modules: { 'demo.crm': 'write' } }, [
          read,
          entry(applyCommandKey),
        ]),
      ),
    ).toBe(true);
  }
});

it('an explicit mode override replaces broader role modes rather than unioning them', () => {
  const key = eraseKey;
  const role: PolicyRole = {
    capabilityKeys: { 'demo.crm': [key] },
    capabilityModes: { [key]: ['run'] },
    label: 'Run only',
    modules: { 'demo.crm': 'write' },
    proposalReview: true,
    restrictedModules: ['demo.crm'],
  };
  const compiled = policyRoleCells(role, catalog);
  expect(Result.isSuccess(compiled)).toBe(true);
  if (Result.isSuccess(compiled)) {
    expect(compiled.success.filter((cell) => cell.capabilityKey === key).map((cell) => cell.mode)).toEqual(['run']);
  }
});

it('a mode override cannot grant approval, an undeclared mode or an unselected capability', () => {
  const key = mergeKey;
  const base: PolicyRole = {
    capabilityKeys: { 'demo.crm': [key] },
    label: 'Restricted writer',
    modules: { 'demo.crm': 'write' },
    restrictedModules: ['demo.crm'],
  };
  const modeCases: NonNullable<PolicyRole['capabilityModes']>[] = [
    { [key]: ['approve'] },
    { [key]: [] },
    { [key]: ['run', 'run'] },
    { 'work.tasks.apply-command': ['run'] },
  ];
  for (const capabilityModes of modeCases) {
    expect(Result.isFailure(policyRoleCells({ ...base, capabilityModes }, catalog))).toBe(true);
  }
  // Even a reviewer cannot add approve when the owner declares run/propose only.
  expect(
    Result.isFailure(
      policyRoleCells({ ...base, capabilityModes: { [key]: ['approve'] }, proposalReview: true }, catalog),
    ),
  ).toBe(true);
});
