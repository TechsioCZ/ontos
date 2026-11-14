import { Result, Schema } from 'effect';
import { expect, it } from 'effect-rstest';

import { CatalogSnapshotEntrySchema } from '../../packages/core-runtime/src/access/model.ts';
import { policyRoleCellRows } from '../demo/access-policy.mts';
import {
  crmReadCapability,
  facilityPersonalAgendaCapability,
  pipelineReadCapability,
  siamparkRentalPersonas,
} from '../demo/permissions.mts';

// Source-only policy proof while the owner finishes its transport. No production artifact fallback.
const { 3: external } = siamparkRentalPersonas;
const catalog = Object.values(external.role.capabilityKeys)
  .flat()
  .map((key) =>
    Schema.decodeUnknownSync(CatalogSnapshotEntrySchema)({
      key,
      kind: key === facilityPersonalAgendaCapability ? 'action' : 'read',
      modes: key === facilityPersonalAgendaCapability ? ['run', 'propose'] : ['run'],
      moduleKey: key.split('.').slice(0, 2).join('.'),
      placement: { group: 'personal-agenda', level: 'extended' },
      risk: key === facilityPersonalAgendaCapability ? 'sensitive' : 'routine',
      selectors: key === crmReadCapability || key === pipelineReadCapability ? ['all', 'assigned', 'entrusted'] : [],
    }),
  );

it('prepares exactly RUN for the external personal-agenda Action without broader module authority', () => {
  const compiled = policyRoleCellRows(external.role, catalog);
  expect(Result.isSuccess(compiled)).toBe(true);
  if (Result.isFailure(compiled)) {
    return;
  }
  expect(compiled.success.filter(({ capabilityKey }) => capabilityKey === facilityPersonalAgendaCapability)).toEqual([
    { capabilityKey: facilityPersonalAgendaCapability, mode: 'run', selector: 'all' },
  ]);
  expect(compiled.success.some(({ mode }) => mode === 'approve' || mode === 'propose')).toBe(false);
  for (const forbidden of [
    'facility.operations.apply-command.write',
    'facility.operations.records-restricted.read',
    'facility.operations.records-restricted.write',
  ]) {
    expect(compiled.success.some(({ capabilityKey }) => capabilityKey === forbidden)).toBe(false);
  }
});

it('keeps the external assignment in its reviewed company, never a machine or a tenant-wide grant', () => {
  expect(external.email).toBe('external@najempark.demo');
  expect(external.principalId).toBe('72000000-0000-4000-8000-000000000024');
  expect(external.role.modules['facility.operations']).toBe('read');
  expect(external.role.restrictedModules).toContain('facility.operations');
});

it('fails closed until the pinned catalog publishes the new purpose capability', () => {
  const missing = catalog.filter(({ key }) => key !== facilityPersonalAgendaCapability);
  expect(Result.isFailure(policyRoleCellRows(external.role, missing))).toBe(true);
});
