import { fileURLToPath } from 'node:url';

import { NodeServices } from '@effect/platform-node';
import { Effect, Result } from 'effect';
import { expect, it } from 'effect-rstest';
import { compileFullAccessRole } from '@app/core-runtime/access/bootstrap';
import { buildAccessCatalogRelease } from '@app/core-runtime/access/catalog';
import { ModuleKeySchema } from '@app/core-runtime/access/ids';

import { bootstrapDemoPermissionContexts } from '../demo/reset-permissions.mts';
import { demoLegalEntityId, demoTenantId } from '../demo/fixture-ids.mts';

import { readAccessCatalogArtifact } from '../authorization-catalog-artifact.mts';
import { policyReleaseEntries, policyRoleCellRows } from '../demo/access-policy.mts';
import {
  crmAssignCapability,
  crmDemoRoles,
  crmPartyIntakePrincipal,
  crmReadCapability,
  crmWriteCapability,
  demoModuleIds,
  demoShellRoutingRole,
  demoShellRoutingRoleKey,
  demoTenantMemberships,
  facilityPersonalAgendaCapability,
  pipelineEntrustCapability,
  pipelineReadCapability,
  pipelineSearchCapability,
  pipelineWriteCapability,
  partyHumanReaderKeys,
  tenantModuleTargetCapability,
  reviewedDemoAssignments,
  siamparkRentalPersonas,
  tenantAdministratorCrmRole,
  tenantAdministratorPipelineRole,
} from '../demo/permissions.mts';

const releaseEntries = Effect.gen(function* demoReleaseEntries() {
  const modules = yield* readAccessCatalogArtifact(fileURLToPath(new URL('../..', import.meta.url)));
  const release = policyReleaseEntries(modules, demoModuleIds);
  expect(Result.isSuccess(release)).toBe(true);
  return yield* Effect.fromResult(release);
});
const retiredPurposeKeys = new Set([
  'party.registry.crm-client-party.create',
  'party.registry.crm-client-intake-review.read',
]);

it.effect('compiles every reviewed demo assignment against the actual generated catalog', () =>
  Effect.gen(function* compiledAssignments() {
    const catalog = yield* releaseEntries;
    for (const { role, roleKey } of reviewedDemoAssignments()) {
      const compiled = policyRoleCellRows(role, catalog, role.actorKind ?? 'human');
      expect(Result.isSuccess(compiled), Result.isFailure(compiled) ? `${roleKey}: ${compiled.failure}` : roleKey).toBe(
        true,
      );
    }
  }).pipe(Effect.provide(NodeServices.layer)),
);

it.effect('pins exact CRM cells without unioning broader module grants', () =>
  Effect.gen(function* exactCrmCells() {
    const catalog = yield* releaseEntries;
    for (const [role, selector, write, assign] of [
      [crmDemoRoles.crmAdmin, 'all', true, true],
      [crmDemoRoles.crmManager, 'all', true, true],
      [tenantAdministratorCrmRole, 'all', true, true],
      [crmDemoRoles.crmRep, 'assigned', true, false],
      [siamparkRentalPersonas[3].role, 'entrusted', false, false],
    ] as const) {
      const cells = yield* Effect.fromResult(policyRoleCellRows(role, catalog));
      expect(cells.filter(({ capabilityKey }) => capabilityKey === crmReadCapability)).toEqual([
        { capabilityKey: crmReadCapability, mode: 'run', selector },
      ]);
      expect(cells.some(({ capabilityKey }) => capabilityKey === crmWriteCapability)).toBe(write);
      expect(cells.some(({ capabilityKey }) => capabilityKey === crmAssignCapability)).toBe(assign);
      expect(cells.some(({ capabilityKey }) => capabilityKey === 'demo.crm.navigation-clients.read')).toBe(true);
      expect(cells.some(({ capabilityKey }) => capabilityKey === 'demo.crm.page-clients.read')).toBe(true);
    }
  }).pipe(Effect.provide(NodeServices.layer)),
);

it.effect('keeps facility restricted reads out of the external operational role', () =>
  Effect.gen(function* exactFacilityCells() {
    const catalog = yield* releaseEntries;
    expect(catalog.find(({ key }) => key === facilityPersonalAgendaCapability)?.modes).toEqual(['run', 'propose']);
    for (const [index, persona] of siamparkRentalPersonas.entries()) {
      const cells = yield* Effect.fromResult(policyRoleCellRows(persona.role, catalog));
      const keys = cells.map(({ capabilityKey }) => capabilityKey);
      expect(keys).toContain('facility.operations.api-records.read');
      expect(keys).toContain('facility.operations.navigation-agenda.read');
      expect(keys.includes('facility.operations.records-restricted.read')).toBe(index !== 3);
      expect(keys.includes('facility.operations.apply-command.write')).toBe(index !== 3);
      if (index === 3) {
        expect(cells.filter(({ capabilityKey }) => capabilityKey === facilityPersonalAgendaCapability)).toEqual([
          { capabilityKey: facilityPersonalAgendaCapability, mode: 'run', selector: 'all' },
        ]);
        expect(cells.some(({ mode }) => mode === 'approve')).toBe(false);
      }
    }
  }).pipe(Effect.provide(NodeServices.layer)),
);

it.effect('pins pipeline ENTRUSTED reads and keeps entrustment assignment off ordinary writers', () =>
  Effect.gen(function* exactPipelineCells() {
    const catalog = yield* releaseEntries;
    for (const [role, selector, write, assign] of [
      [siamparkRentalPersonas[0].role, 'all', true, true],
      [siamparkRentalPersonas[1].role, 'all', true, false],
      [siamparkRentalPersonas[4].role, 'all', true, false],
      [siamparkRentalPersonas[3].role, 'entrusted', false, false],
      [tenantAdministratorPipelineRole, 'all', true, true],
    ] as const) {
      const cells = yield* Effect.fromResult(policyRoleCellRows(role, catalog));
      expect(cells.filter(({ capabilityKey }) => capabilityKey === pipelineReadCapability)).toEqual([
        { capabilityKey: pipelineReadCapability, mode: 'run', selector },
      ]);
      expect(cells.some(({ capabilityKey }) => capabilityKey === pipelineWriteCapability)).toBe(write);
      expect(cells.some(({ capabilityKey }) => capabilityKey === pipelineEntrustCapability)).toBe(assign);
      if (selector === 'entrusted') {
        expect(cells.some(({ capabilityKey }) => capabilityKey === pipelineSearchCapability)).toBe(false);
      }
    }
  }).pipe(Effect.provide(NodeServices.layer)),
);

it.effect('does not turn purpose-only intake into a human or machine Role in the published catalog', () =>
  Effect.gen(function* noIntakeRoleCells() {
    const catalog = yield* releaseEntries;
    expect(catalog.some(({ key }) => retiredPurposeKeys.has(key))).toBe(false);
    const workloadOnlyKeys = new Set(['demo.crm.api.pending-client-intake', 'demo.crm.intake-client-party']);
    expect(catalog.some(({ key }) => workloadOnlyKeys.has(key))).toBe(false);
    for (const { principalId, role } of reviewedDemoAssignments()) {
      expect(principalId).not.toBe(crmPartyIntakePrincipal.principalId);
      const cells = yield* Effect.fromResult(policyRoleCellRows(role, catalog));
      expect(
        cells.some(({ capabilityKey }) => retiredPurposeKeys.has(capabilityKey) || workloadOnlyKeys.has(capabilityKey)),
      ).toBe(false);
      if (role.modules['party.registry'] === 'read') {
        const partyCells = cells.filter(({ capabilityKey }) => capabilityKey.startsWith('party.registry.'));
        expect(partyCells.map(({ capabilityKey }) => capabilityKey).toSorted()).toEqual(
          [...partyHumanReaderKeys].toSorted(),
        );
        expect(partyCells.every(({ mode }) => mode === 'run')).toBe(true);
      }
    }
  }).pipe(Effect.provide(NodeServices.layer)),
);

it.effect('keeps generic Party Create but no retired purpose cells in the unchanged full-owner compiler', () =>
  Effect.gen(function* actualFullOwnerCatalog() {
    const modules = yield* readAccessCatalogArtifact(fileURLToPath(new URL('../..', import.meta.url)));
    const release = yield* Effect.fromResult(
      buildAccessCatalogRelease({
        installedModuleKeys: modules.map(({ moduleId }) => ModuleKeySchema.make(moduleId)),
        modules,
        publishedAt: new Date(0),
      }),
    );
    expect(release.entries.some(({ key }) => retiredPurposeKeys.has(key))).toBe(false);
    const owner = yield* Effect.fromResult(compileFullAccessRole(release));
    expect(owner.cells.some(({ capabilityKey }) => retiredPurposeKeys.has(capabilityKey))).toBe(false);
    expect(owner.cells.some(({ capabilityKey }) => capabilityKey === 'party.registry.party.create')).toBe(true);
  }).pipe(Effect.provide(NodeServices.layer)),
);

it.effect('lets the accountant read and work the Tasks assigned to her in Obchodní firma', () =>
  Effect.gen(function* accountantTaskCells() {
    const catalog = yield* releaseEntries;
    const accounting = reviewedDemoAssignments().filter(({ roleKey }) => roleKey === 'accounting');
    expect(accounting.map(({ legalEntityId }) => legalEntityId)).toEqual([demoLegalEntityId]);
    for (const { role } of accounting) {
      const cells = yield* Effect.fromResult(policyRoleCellRows(role, catalog));
      for (const capabilityKey of ['work.tasks.api-records.read', 'work.tasks.apply-command.write']) {
        expect(cells).toContainEqual({ capabilityKey, mode: 'run', selector: 'all' });
      }
    }
  }).pipe(Effect.provide(NodeServices.layer)),
);

it.effect('grants the exact Shell routing cell in tenant scope to every reviewed demo person', () =>
  Effect.gen(function* tenantRoutingCells() {
    const catalog = yield* releaseEntries;
    expect(yield* Effect.fromResult(policyRoleCellRows(demoShellRoutingRole, catalog))).toEqual([
      { capabilityKey: tenantModuleTargetCapability, mode: 'run', selector: 'all' },
    ]);
    const assignments = reviewedDemoAssignments().filter(({ roleKey }) => roleKey === demoShellRoutingRoleKey);
    expect(new Set(assignments.map(({ principalId }) => principalId))).toEqual(
      new Set(demoTenantMemberships.map(({ principalId }) => principalId)),
    );
    expect(assignments.every(({ legalEntityId }) => legalEntityId === undefined)).toBe(true);
  }).pipe(Effect.provide(NodeServices.layer)),
);

it.effect('carries routing Roles, tenant memberships and assignments through the production demo fixture port', () =>
  Effect.gen(function* routingBootstrapFixture() {
    const modules = yield* readAccessCatalogArtifact(fileURLToPath(new URL('../..', import.meta.url)));
    let sawDemo = false;
    yield* bootstrapDemoPermissionContexts(modules, (context) =>
      Effect.sync(() => {
        for (const role of context.access.roles) {
          expect(role.cells.some(({ capabilityKey }) => retiredPurposeKeys.has(capabilityKey))).toBe(false);
        }
        if (context.tenant.tenantId !== demoTenantId) {
          return;
        }
        sawDemo = true;
        const role = context.access.roles.find(({ key }) => key === demoShellRoutingRoleKey);
        expect(role?.legalEntityId).toBeUndefined();
        expect(role?.cells).toEqual([{ capabilityKey: tenantModuleTargetCapability, mode: 'run', selector: 'all' }]);
        for (const { principalId } of demoTenantMemberships) {
          expect(context.access.assignments).toContainEqual({ principalId, roleKey: demoShellRoutingRoleKey });
          expect(context.access.memberships).toContainEqual({ kind: 'member', principalId });
        }
        expect(context.accounts.some(({ authUserId }) => authUserId.startsWith('demo-warmup-'))).toBe(false);
      }),
    );
    expect(sawDemo).toBe(true);
  }).pipe(Effect.provide(NodeServices.layer)),
);
