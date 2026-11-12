import { Result, Schema } from 'effect';
import { expect, it } from 'effect-rstest';

import type { CatalogSnapshotEntry } from '../../packages/core-runtime/src/access/model.ts';
import { CatalogSnapshotEntrySchema } from '../../packages/core-runtime/src/access/model.ts';
import { ModuleKeySchema } from '../../packages/core-runtime/src/access/ids.ts';
import { PROPOSAL_REVIEW_CAPABILITY, policyRoleCells, policyRoleKeys } from '../demo/access-policy.mts';
import {
  crmDemoRoles,
  crmReadCapability,
  crmWriteCapability,
  crmAssignCapability,
  crmNavigationKeys,
  demoRoles,
  eshopDemoRoles,
  rentalDemoRoles,
  pipelineWriterKeys,
  partyHumanWriterKeys,
  taxManagerKeys,
} from '../demo/permissions.mts';
import type { DemoRole } from '../demo/permissions.mts';

const entry = (key: string, overrides: Partial<CatalogSnapshotEntry> = {}): CatalogSnapshotEntry =>
  Schema.decodeUnknownSync(CatalogSnapshotEntrySchema)({
    key,
    kind: 'action',
    modes: ['run', 'propose', 'approve'],
    moduleKey: key.split('.').slice(0, 2).join('.'),
    placement: { group: 'records', level: 'basic' },
    risk: 'sensitive',
    selectors: [],
    ...overrides,
  });

/** Every module the reviewed Roles name, each with one routine read capability. */
const modulesNamedByRoles = [
  'commerce.customer-context',
  'commerce.market-catalog',
  'commerce.storefront-registry',
  'commerce.tax',
  'core.identity',
  'crm.activities',
  'demo.crm',
  'demo.merchandise',
  'demo.sales-insights',
  'demo.sales-pipeline',
  'demo.tagging',
  'demo.workforce',
  'facility.operations',
  'finance.billing',
  'legal.agreements',
  'party.registry',
  'privacy.core',
  'property.leasing',
  'property.portfolio',
  'work.tasks',
] as const;
const namedCapabilityKeys = [
  ...pipelineWriterKeys,
  ...partyHumanWriterKeys,
  ...crmNavigationKeys,
  crmReadCapability,
  crmWriteCapability,
  crmAssignCapability,
  'commerce.customer-context.market-use.assess',
  'commerce.customer-context.portal-enrollment.terminate',
  'commerce.customer-context.profile-reconciliation.open',
  'commerce.customer-context.profile-reconciliation.resolve',
  'commerce.customer-context.retail-portal-profile-binding.recover',
  'commerce.customer-context.retail-portal-profile-binding.revoke',
  'privacy.core.processing-purpose.create',
  'privacy.core.notice-version.create',
  ...taxManagerKeys,
] as const;
const catalog: readonly CatalogSnapshotEntry[] = [
  entry(PROPOSAL_REVIEW_CAPABILITY, { moduleKey: ModuleKeySchema.make('core.identity') }),
  ...modulesNamedByRoles.map((moduleKey) =>
    entry(`${moduleKey}.placeholder.read`, {
      kind: 'read',
      modes: ['run'],
      moduleKey: ModuleKeySchema.make(moduleKey),
      risk: 'routine',
    }),
  ),
  ...namedCapabilityKeys.map((key) =>
    entry(key, {
      moduleKey: ModuleKeySchema.make(key.split('.').slice(0, 2).join('.')),
      risk: 'sensitive',
      ...(key === crmReadCapability
        ? { kind: 'read' as const, modes: ['run'] as const, selectors: ['all', 'assigned', 'entrusted'] as const }
        : { kind: 'action' as const, modes: ['run', 'propose', 'approve'] as const, selectors: [] }),
    }),
  ),
];

const reviewerRoles: readonly (readonly [string, DemoRole])[] = [
  ['accountant', demoRoles.accountant],
  ['headOfSales', demoRoles.headOfSales],
  ['salesRep', demoRoles.salesRep],
  ['warehouse', demoRoles.warehouse],
  ['rental.accountant', rentalDemoRoles.accountant],
  ['rental.headOfSales', rentalDemoRoles.headOfSales],
  ['rental.salesRep', rentalDemoRoles.salesRep],
  ['crmAdmin', crmDemoRoles.crmAdmin],
  ['crmManager', crmDemoRoles.crmManager],
  ['crmRep', crmDemoRoles.crmRep],
  ['eshopAdmin', eshopDemoRoles.eshopAdmin],
  ['eshopFulfilment', eshopDemoRoles.fulfilment],
];

it('grants the one reviewed proposal capability to every reviewer Role, at its declared approve mode', () => {
  for (const [label, role] of reviewerRoles) {
    expect(role.proposalReview).toBe(true);
    expect(policyRoleKeys(role, catalog)).toContain(PROPOSAL_REVIEW_CAPABILITY);
    const compiled = policyRoleCells(role, catalog);
    expect(Result.isSuccess(compiled)).toBe(true);
    if (Result.isSuccess(compiled)) {
      const modes = compiled.success
        .filter((cell) => cell.capabilityKey === PROPOSAL_REVIEW_CAPABILITY)
        .map((cell) => cell.mode)
        .toSorted();
      expect({ label, modes }).toEqual({ label, modes: ['approve', 'propose', 'run'] });
    }
  }
});

it('never infers proposal review from a role name, a label or business write access', () => {
  const plain: DemoRole = { label: 'Administrator', modules: { 'work.tasks': 'write' } };
  expect(policyRoleKeys(plain, catalog)).not.toContain(PROPOSAL_REVIEW_CAPABILITY);
  const compiled = policyRoleCells(plain, catalog);
  expect(Result.isSuccess(compiled)).toBe(true);
  if (Result.isSuccess(compiled)) {
    expect(compiled.success.map((cell) => cell.capabilityKey)).toEqual(['work.tasks.placeholder.read']);
  }
});

it('keeps the agent bot off the proposal lifecycle and off every read it does not declare', () => {
  const agent: DemoRole = { actorKind: 'agent', label: 'Agent', modules: { 'work.tasks': 'write' } };
  const compiled = policyRoleCells(agent, catalog, 'agent');
  expect(Result.isSuccess(compiled)).toBe(true);
  if (Result.isSuccess(compiled)) {
    // The agent runs the routine capability of its module and never reaches a read or the proposal lifecycle.
    expect(compiled.success.map(({ capabilityKey, mode }) => `${capabilityKey}:${mode}`)).toEqual([
      'work.tasks.placeholder.read:run',
    ]);
  }
  const reviewer: DemoRole = { label: 'Agent reviewer', modules: { 'work.tasks': 'write' }, proposalReview: true };
  const reviewerCells = policyRoleCells(reviewer, catalog, 'agent');
  expect(Result.isSuccess(reviewerCells)).toBe(true);
  if (Result.isSuccess(reviewerCells)) {
    expect(reviewerCells.success.map((cell) => cell.capabilityKey)).toContain(PROPOSAL_REVIEW_CAPABILITY);
    expect(
      reviewerCells.success
        .filter((cell) => cell.capabilityKey === PROPOSAL_REVIEW_CAPABILITY)
        .every((cell) => cell.mode === 'propose'),
    ).toBe(true);
  }
});
