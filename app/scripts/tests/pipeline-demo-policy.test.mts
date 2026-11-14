import type { CatalogSnapshotEntry } from '../../packages/core-runtime/src/access/model.ts';
import { Result, Schema } from 'effect';
import { expect, it } from 'effect-rstest';

import { CatalogSnapshotEntrySchema } from '../../packages/core-runtime/src/access/model.ts';
import { policyRoleCellRows } from '../demo/access-policy.mts';
import {
  crmReadCapability,
  demoRoles,
  facilityPersonalAgendaCapability,
  pipelineEntrustCapability,
  pipelineReadCapability,
  pipelineSearchCapability,
  pipelineWriteCapability,
  pipelineWriterKeys,
  rentalDemoRoles,
  reviewedDemoAssignments,
  siamparkRentalPersonas,
  tenantAdministratorPipelineRole,
} from '../demo/permissions.mts';
import type { DemoRole } from '../demo/permissions.mts';
import { demoLegalEntityId, rentalDemoLegalEntityId } from '../demo/fixture-ids.mts';

const pipelineModule = 'demo.sales-pipeline';
const external = siamparkRentalPersonas[3].role;
const roles: readonly DemoRole[] = [
  demoRoles.headOfSales,
  demoRoles.salesRep,
  rentalDemoRoles.headOfSales,
  rentalDemoRoles.salesRep,
  siamparkRentalPersonas[1].role,
  siamparkRentalPersonas[4].role,
  external,
  tenantAdministratorPipelineRole,
];
// A source-only release fixture. The generated artifact proof waits for the owner's stable transport.
const keys = new Set([
  ...pipelineWriterKeys,
  pipelineEntrustCapability,
  ...roles.flatMap((role) => Object.values(role.capabilityKeys ?? {}).flat()),
  ...roles.flatMap((role) =>
    Object.keys(role.modules)
      .filter((key) => key !== pipelineModule)
      .map((moduleKey) => `${moduleKey}.placeholder.read`),
  ),
]);
const catalog = [...keys].map((key) => {
  const base = {
    key,
    moduleKey: key.split('.').slice(0, 2).join('.'),
    placement: { group: 'records', level: 'manage' },
    risk: 'sensitive',
  };
  if (key === pipelineEntrustCapability) {
    return Schema.decodeUnknownSync(CatalogSnapshotEntrySchema)({
      ...base,
      fieldClass: 'authority_metadata',
      kind: 'field_write',
      modes: ['run', 'propose', 'approve'],
      parentKey: pipelineWriteCapability,
      selectors: [],
    });
  }
  if (key === pipelineWriteCapability || key === facilityPersonalAgendaCapability) {
    return Schema.decodeUnknownSync(CatalogSnapshotEntrySchema)({
      ...base,
      kind: 'action',
      modes: key === facilityPersonalAgendaCapability ? ['run', 'propose'] : ['run', 'propose', 'approve'],
      selectors: [],
    });
  }
  let selectors: CatalogSnapshotEntry['selectors'] = [];
  if (key === pipelineReadCapability) {
    selectors = ['all', 'entrusted'];
  } else if (key === crmReadCapability) {
    selectors = ['all', 'assigned', 'entrusted'];
  }
  return Schema.decodeUnknownSync(CatalogSnapshotEntrySchema)({ ...base, kind: 'read', modes: ['run'], selectors });
});
const cellsFor = (role: DemoRole) => {
  const compiled = policyRoleCellRows(role, catalog);
  expect(Result.isSuccess(compiled), Result.isFailure(compiled) ? compiled.failure : '').toBe(true);
  return Result.isSuccess(compiled)
    ? compiled.success.filter(({ capabilityKey }) => capabilityKey.startsWith(`${pipelineModule}.`))
    : [];
};

it('grants the external partner ENTRUSTED records only, never ALL, search, command or entrustment write', () => {
  const cells = cellsFor(external);
  expect(cells.filter(({ capabilityKey }) => capabilityKey === pipelineReadCapability)).toEqual([
    { capabilityKey: pipelineReadCapability, mode: 'run', selector: 'entrusted' },
  ]);
  for (const forbidden of [pipelineSearchCapability, pipelineWriteCapability, pipelineEntrustCapability]) {
    expect(cells.some(({ capabilityKey }) => capabilityKey === forbidden)).toBe(false);
  }
  expect(cells.some(({ mode }) => mode !== 'run')).toBe(false);
});

it('does not let ordinary module writers acquire the new entrustment field-write group', () => {
  for (const role of [
    demoRoles.salesRep,
    rentalDemoRoles.salesRep,
    siamparkRentalPersonas[1].role,
    siamparkRentalPersonas[4].role,
  ]) {
    const cells = cellsFor(role);
    expect(cells.some(({ capabilityKey }) => capabilityKey === pipelineWriteCapability)).toBe(true);
    expect(cells.some(({ capabilityKey }) => capabilityKey === pipelineEntrustCapability)).toBe(false);
  }
});

it('keeps full-read and entrustment authority with the reviewed managers and tenant administrator', () => {
  for (const role of [demoRoles.headOfSales, rentalDemoRoles.headOfSales, tenantAdministratorPipelineRole]) {
    const cells = cellsFor(role);
    expect(cells.filter(({ capabilityKey }) => capabilityKey === pipelineReadCapability)).toEqual([
      { capabilityKey: pipelineReadCapability, mode: 'run', selector: 'all' },
    ]);
    expect(cells.some(({ capabilityKey, mode }) => capabilityKey === pipelineEntrustCapability && mode === 'run')).toBe(
      true,
    );
  }
  const overlays = reviewedDemoAssignments().filter(({ role }) => role === tenantAdministratorPipelineRole);
  expect(overlays.map(({ legalEntityId }) => legalEntityId)).toEqual([demoLegalEntityId, rentalDemoLegalEntityId]);
  expect(overlays.every(({ legalEntityId }) => legalEntityId !== undefined)).toBe(true);
});
