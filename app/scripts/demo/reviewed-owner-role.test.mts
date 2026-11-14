import { fileURLToPath } from 'node:url';
import { NodeServices } from '@effect/platform-node';
import { Effect, Result } from 'effect';
import { expect, it } from 'effect-rstest';

import { readAccessCatalogArtifact } from '../authorization-catalog-artifact.mts';
import { policyReleaseEntries, policyRoleCellRows } from './access-policy.mts';
import {
  companyHumanAccounts,
  crmDemoRoles,
  demoHumanAccounts,
  demoModuleIds,
  demoRoles,
  eshopDemoRoles,
  rentalDemoRoles,
  reviewedDemoAssignments,
  reviewedMachinePrincipals,
} from './permissions.mts';
import type { DemoRole } from './permissions.mts';
import {
  crmDemoLegalEntityId,
  demoId,
  demoLegalEntityId,
  demoTenantId,
  eshopDemoLegalEntityId,
  rentalDemoLegalEntityId,
} from './fixture-ids.mts';
import { recoveredRecordActions, reviewedCompanyRole } from './reviewed-owner-role.mts';
import { reviewedSiamparkAccess } from '../siampark/reset-demo.mts';

const workforce = 'demo.workforce';
const tagging = 'demo.tagging';
const insights = 'demo.sales-insights';
const recovered = Object.values(recoveredRecordActions).flat();
const recoveredSet = new Set<string>(recovered);
const maintenance = new Set([
  'demo.workforce.request-search-rebuild.write',
  'demo.merchandise.request-search-rebuild.write',
  'demo.merchandise.bootstrap-playground-catalog.write',
]);
const release = Effect.gen(function* sourceCatalog() {
  const modules = yield* readAccessCatalogArtifact(fileURLToPath(new URL('../..', import.meta.url)));
  return { entries: yield* Effect.fromResult(policyReleaseEntries(modules, demoModuleIds)), modules };
});
const recoveredCells = (role: DemoRole, principalId: string, legalEntityId?: string, tenantId: string = demoTenantId) =>
  release.pipe(
    Effect.flatMap(({ entries }) =>
      Effect.fromResult(
        policyRoleCellRows(reviewedCompanyRole(role, legalEntityId, { principalId, tenantId }), entries),
      ),
    ),
    Effect.map((cells) => cells.filter(({ capabilityKey }) => recoveredSet.has(capabilityKey))),
  );
const keysOf = (cells: readonly { readonly capabilityKey: string }[]) =>
  cells.map(({ capabilityKey }) => capabilityKey).toSorted();
const representative = demoHumanAccounts[0].principalId;

it.effect('restores only reviewed whole-company record operations as RUN/ALL for actual human writers', () =>
  Effect.gen(function* actualWriterCells() {
    const cells = yield* recoveredCells(demoRoles.headOfSales, representative, demoLegalEntityId);
    expect(keysOf(cells)).toEqual([...recovered].toSorted());
    expect(cells.every((cell) => cell.mode === 'run' && cell.selector === 'all')).toBe(true);
    const rep = yield* recoveredCells(demoRoles.salesRep, demoHumanAccounts[1].principalId, demoLegalEntityId);
    expect(keysOf(rep)).toEqual([...recoveredRecordActions[tagging]].toSorted());
    const manager = yield* recoveredCells(
      crmDemoRoles.crmManager,
      demoId('core.principal', 'hanak-vedouci'),
      crmDemoLegalEntityId,
    );
    expect(keysOf(manager)).toEqual([...recoveredRecordActions[workforce]]);
  }).pipe(Effect.provide(NodeServices.layer)),
);

it.effect(
  'keeps readers, restricted module writers, agents and unreviewed identities out of recovered target cells',
  () =>
    Effect.gen(function* refusedSourceGrants() {
      const reader: DemoRole = {
        label: 'Reader',
        modules: { [insights]: 'read', [tagging]: 'read', [workforce]: 'read' },
      };
      expect(yield* recoveredCells(reader, representative, demoLegalEntityId)).toEqual([]);
      const restricted: DemoRole = {
        ...demoRoles.salesRep,
        restrictedModules: [...demoRoles.salesRep.restrictedModules, tagging],
      };
      expect(yield* recoveredCells(restricted, demoHumanAccounts[1].principalId, demoLegalEntityId)).toEqual([]);
      expect(
        yield* recoveredCells({ ...demoRoles.headOfSales, actorKind: 'agent' }, representative, demoLegalEntityId),
      ).toEqual([]);
      for (const machine of reviewedMachinePrincipals) {
        expect(yield* recoveredCells(demoRoles.headOfSales, machine.principalId, demoLegalEntityId)).toEqual([]);
      }
      expect(
        yield* recoveredCells(demoRoles.headOfSales, '72000000-0000-4000-8000-000000000099', demoLegalEntityId),
      ).toEqual([]);
    }).pipe(Effect.provide(NodeServices.layer)),
);

it.effect(
  'recovers the exact Workforce company-admin exception without inventing Tagging or Insights administration',
  () =>
    Effect.gen(function* companyAdministratorCells() {
      const rental = yield* recoveredCells(
        rentalDemoRoles.headOfSales,
        '72000000-0000-4000-8000-000000000021',
        rentalDemoLegalEntityId,
      );
      expect(keysOf(rental)).toEqual(
        [...recoveredRecordActions[workforce], ...recoveredRecordActions[tagging]].toSorted(),
      );
      const adminReadOnly: DemoRole = {
        companyAdmin: true,
        label: 'Company administration is not a business write grant',
        modules: { [insights]: 'read', [tagging]: 'read', [workforce]: 'read' },
      };
      const eshop = companyHumanAccounts.find((account) => account.role === 'eshopAdmin');
      expect(eshop).toBeDefined();
      if (eshop !== undefined) {
        expect(keysOf(yield* recoveredCells(adminReadOnly, eshop.principalId, eshop.legalEntityId))).toEqual([
          ...recoveredRecordActions[workforce],
        ]);
      }
      expect(yield* recoveredCells(adminReadOnly, demoHumanAccounts[1].principalId, demoLegalEntityId)).toEqual([]);
    }).pipe(Effect.provide(NodeServices.layer)),
);

it.effect(
  'binds recovered rights to the original tenant, company and human source, and materializes idempotently',
  () =>
    Effect.gen(function* exactSourceScopes() {
      const managerId = demoId('core.principal', 'hanak-vedouci');
      expect(yield* recoveredCells(crmDemoRoles.crmManager, managerId, eshopDemoLegalEntityId)).toEqual([]);
      expect(
        yield* recoveredCells(
          crmDemoRoles.crmManager,
          managerId,
          crmDemoLegalEntityId,
          '70000000-0000-4000-8000-000000000099',
        ),
      ).toEqual([]);
      expect(yield* recoveredCells(crmDemoRoles.crmManager, managerId)).toEqual([]);
      const source = { principalId: representative, tenantId: demoTenantId };
      const first = reviewedCompanyRole(demoRoles.headOfSales, demoLegalEntityId, source);
      expect(reviewedCompanyRole(first, demoLegalEntityId, source)).toEqual(first);
      // Sharing fulfilment across company023/024 does not create a resource-write grant.
      expect(yield* recoveredCells(eshopDemoRoles.fulfilment, representative, eshopDemoLegalEntityId)).toEqual([]);
    }).pipe(Effect.provide(NodeServices.layer)),
);

it.effect(
  'publishes only the approved source cells and retains exact baseline-company writer scopes without writes',
  () =>
    Effect.gen(function* actualSourcePayload() {
      const { entries, modules } = yield* release;
      for (const assignment of reviewedDemoAssignments()) {
        const cells = yield* Effect.fromResult(policyRoleCellRows(assignment.role, entries));
        expect(cells.filter(({ capabilityKey }) => maintenance.has(capabilityKey))).toEqual([]);
        const targetCells = cells.filter(({ capabilityKey }) => recoveredSet.has(capabilityKey));
        expect(targetCells.every((cell) => cell.mode === 'run' && cell.selector === 'all')).toBe(true);
      }
      const baseline = reviewedSiamparkAccess(modules);
      expect(Result.isSuccess(baseline)).toBe(true);
      if (Result.isSuccess(baseline)) {
        const operations = baseline.success.roles.find((role) => role.key === 'najempark-operations');
        const management = baseline.success.roles.find((role) => role.key === 'najempark-management');
        expect(keysOf(operations?.cells.filter(({ capabilityKey }) => recoveredSet.has(capabilityKey)) ?? [])).toEqual(
          [...recovered].toSorted(),
        );
        expect(management?.cells.filter(({ capabilityKey }) => recoveredSet.has(capabilityKey))).toEqual([]);
        expect(
          baseline.success.assignments
            .filter(({ roleKey }) => roleKey === 'najempark-operations')
            .every(({ legalEntityId }) => legalEntityId === demoLegalEntityId),
        ).toBe(true);
      }
    }).pipe(Effect.provide(NodeServices.layer)),
);
