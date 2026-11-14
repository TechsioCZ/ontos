import { fileURLToPath } from 'node:url';
import { NodeServices } from '@effect/platform-node';
import { Effect, Schema } from 'effect';
import { expect, it } from 'effect-rstest';

import { readAccessCatalogArtifact } from '../authorization-catalog-artifact.mts';
import { policyReleaseEntries, policyRoleCellRows } from '../demo/access-policy.mts';
import type { PolicyCellRow } from '../demo/access-policy.mts';
import {
  companyHumanAccounts,
  demoHumanAccounts,
  demoModuleIds,
  eshopDemoRoles,
  reviewedDemoAssignments,
  reviewedMachinePrincipals,
  reviewedWorkloadBindings,
  siamparkRentalPersonas,
} from '../demo/permissions.mts';
import { merchandiseRestrictedCompanyIds, reviewedCompanyRole } from '../demo/reviewed-owner-role.mts';
import {
  akrosDemoLegalEntityId,
  crmDemoLegalEntityId,
  demoId,
  demoLegalEntityId,
  demoTenantId,
  eshopDemoLegalEntityId,
  rentalDemoLegalEntityId,
} from '../demo/fixture-ids.mts';
import { bootstrapDemoPermissionContexts } from '../demo/reset-permissions.mts';
import {
  AKROS_PLAYGROUND_LEGAL_ENTITY_ID,
  assertCommandAllowed,
  isAkrosCompany,
} from '../../verticals/merchandise/shared/actions/command-guard.ts';
import { MerchandisePermissionDenied } from '../../verticals/merchandise/shared/errors/merchandise-permission-denied.ts';

const merchandise = 'demo.merchandise';
const operations = [
  'demo.merchandise.product-images.change',
  'demo.merchandise.stock-movement.record',
  'demo.merchandise.order-status.change',
] as const;
const ordinary = [
  'demo.merchandise.apply-command.write',
  'demo.merchandise.catalog.manage',
  'demo.merchandise.order-changes.review',
  'demo.merchandise.storefront-order.place',
] as const;
const proposal = 'demo.merchandise.order-changes.propose';
const markets = 'demo.merchandise.markets.manage';
const cleanup = 'demo.merchandise.demo.cleanup';
const workforceTargets = ['demo.workforce.employee.update'] as const;
const taggingTargets = [
  'demo.tagging.tag.update',
  'demo.tagging.tag.delete',
  'demo.tagging.tag.assign',
  'demo.tagging.tag.unassign',
] as const;
const insightsTargets = [
  'demo.sales-insights.metric.update',
  'demo.sales-insights.metric.assign',
  'demo.sales-insights.metric-state.change',
] as const;
const recoveredTargets = [...workforceTargets, ...taggingTargets, ...insightsTargets];

const principalResource = 'core.principal';

/** Immutable 71ac40f8 permissions.mts source rows emitted by this producer, not inferred module WRITE. */
const expectedDemoSourceRows = [
  { capabilityKeys: recoveredTargets, legalEntityId: demoLegalEntityId, principalId: demoHumanAccounts[0].principalId },
  { capabilityKeys: taggingTargets, legalEntityId: demoLegalEntityId, principalId: demoHumanAccounts[1].principalId },
  {
    capabilityKeys: [...workforceTargets, ...taggingTargets],
    legalEntityId: rentalDemoLegalEntityId,
    principalId: siamparkRentalPersonas[0].principalId,
  },
  {
    capabilityKeys: taggingTargets,
    legalEntityId: rentalDemoLegalEntityId,
    principalId: siamparkRentalPersonas[1].principalId,
  },
  {
    capabilityKeys: taggingTargets,
    legalEntityId: rentalDemoLegalEntityId,
    principalId: siamparkRentalPersonas[4].principalId,
  },
  {
    capabilityKeys: [...workforceTargets, ...taggingTargets],
    legalEntityId: crmDemoLegalEntityId,
    principalId: demoId(principalResource, 'hanak-spravce'),
  },
  {
    capabilityKeys: workforceTargets,
    legalEntityId: crmDemoLegalEntityId,
    principalId: demoId(principalResource, 'hanak-vedouci'),
  },
  {
    capabilityKeys: workforceTargets,
    legalEntityId: eshopDemoLegalEntityId,
    principalId: demoId(principalResource, 'kavarna-eshop'),
  },
  {
    capabilityKeys: workforceTargets,
    legalEntityId: akrosDemoLegalEntityId,
    principalId: demoId(principalResource, 'sroubarna-eshop'),
  },
];
interface CellSubject {
  readonly legalEntityId: string | undefined;
  readonly principalId: string;
  readonly tenantId: string;
}
const isRecoveredTarget = ({ capabilityKey }: PolicyCellRow): boolean =>
  recoveredTargets.some((key) => key === capabilityKey);
const targetCellIdentity = (subject: CellSubject, cell: PolicyCellRow): string =>
  [
    subject.tenantId,
    subject.legalEntityId ?? 'tenant-context',
    subject.principalId,
    cell.capabilityKey,
    cell.mode,
    cell.selector,
  ].join('/');
const expectedDemoTargetCells = expectedDemoSourceRows
  .flatMap(({ capabilityKeys, legalEntityId, principalId }) =>
    capabilityKeys.map((capabilityKey) =>
      targetCellIdentity(
        { legalEntityId, principalId, tenantId: demoTenantId },
        { capabilityKey, mode: 'run', selector: 'all' },
      ),
    ),
  )
  .toSorted();
const unreviewedMaintenance = [
  'demo.workforce.request-search-rebuild.write',
  'demo.merchandise.request-search-rebuild.write',
  'demo.merchandise.bootstrap-playground-catalog.write',
] as const;
const isUnreviewedMaintenance = ({ capabilityKey }: PolicyCellRow): boolean =>
  unreviewedMaintenance.some((key) => capabilityKey === key);
const release = Effect.gen(function* publishedRelease() {
  const modules = yield* readAccessCatalogArtifact(fileURLToPath(new URL('../..', import.meta.url)));
  return yield* Effect.fromResult(policyReleaseEntries(modules, demoModuleIds));
});

it.effect('compiles the shared fulfilment recipe differently for actual 024 and 023 companies', () =>
  Effect.gen(function* fulfilmentScopes() {
    const catalog = yield* release;
    for (const company of [akrosDemoLegalEntityId, eshopDemoLegalEntityId]) {
      const account = companyHumanAccounts.find(
        ({ legalEntityId, role }) => legalEntityId === company && role === 'fulfilment',
      );
      expect(account).toBeDefined();
      const assigned = reviewedDemoAssignments().find(
        ({ legalEntityId, principalId, role }) =>
          legalEntityId === company && principalId === account?.principalId && role.modules[merchandise] !== undefined,
      );
      expect(assigned).toBeDefined();
      if (assigned === undefined) {
        continue;
      }
      const cells = yield* Effect.fromResult(policyRoleCellRows(assigned.role, catalog));
      const actionKeys = new Set<string>(catalog.filter(({ kind }) => kind === 'action').map(({ key }) => key));
      const actions = cells.filter(
        ({ capabilityKey }) => capabilityKey.startsWith(`${merchandise}.`) && actionKeys.has(capabilityKey),
      );
      expect(actions.map(({ capabilityKey }) => capabilityKey).toSorted()).toEqual(
        [...operations, proposal, ...(company === eshopDemoLegalEntityId ? [...ordinary, markets] : [])].toSorted(),
      );
      expect(actions.every(({ mode }) => mode === 'run')).toBe(true);
    }
  }).pipe(Effect.provide(NodeServices.layer)),
);

it.effect(
  'maps actual company administrators, tenant owner, warehouse writer and company reader without maintenance assumptions',
  () =>
    Effect.gen(function* personaScopes() {
      const catalog = yield* release;
      const adminAccounts = companyHumanAccounts.filter(({ role }) => role === 'akrosAdmin' || role === 'eshopAdmin');
      const cases = [
        ...adminAccounts.map((account) => ({
          company: account.legalEntityId,
          expected: [
            ...operations,
            proposal,
            markets,
            ...(account.legalEntityId === eshopDemoLegalEntityId ? ordinary : []),
          ],
          principal: account.principalId,
        })),
        {
          company: demoLegalEntityId,
          expected: [...operations, ...ordinary, proposal, markets, cleanup],
          principal: demoHumanAccounts[0].principalId,
        },
        {
          company: demoLegalEntityId,
          expected: [...operations, ...ordinary, proposal, markets],
          principal: demoHumanAccounts[3].principalId,
        },
        { company: demoLegalEntityId, expected: [proposal], principal: demoHumanAccounts[2].principalId },
      ];
      const actionKeys = new Set<string>(catalog.filter(({ kind }) => kind === 'action').map(({ key }) => key));
      for (const { company, expected, principal } of cases) {
        const assigned = reviewedDemoAssignments().find(
          ({ legalEntityId, principalId, role }) =>
            legalEntityId === company && principalId === principal && role.modules[merchandise] !== undefined,
        );
        expect(assigned).toBeDefined();
        if (assigned === undefined) {
          continue;
        }
        const cells = yield* Effect.fromResult(policyRoleCellRows(assigned.role, catalog));
        const actions = cells.filter(
          ({ capabilityKey }) => capabilityKey.startsWith(`${merchandise}.`) && actionKeys.has(capabilityKey),
        );
        expect(actions.map(({ capabilityKey }) => capabilityKey).toSorted()).toEqual(expected.toSorted());
        expect(actions.every(({ mode }) => mode === 'run')).toBe(true);
        expect(cells.some(({ capabilityKey }) => capabilityKey === 'demo.merchandise.api-records.read')).toBe(true);
      }
    }).pipe(Effect.provide(NodeServices.layer)),
);

it.effect('grants recovered target RUN cells only to the explicit source principals in their exact companies', () =>
  Effect.gen(function* exactSourceRows() {
    const catalog = yield* release;
    const assignments = reviewedDemoAssignments();
    const actual = new Set<string>();
    for (const { legalEntityId, principalId, role, roleKey } of assignments) {
      const cells = yield* Effect.fromResult(policyRoleCellRows(role, catalog));
      expect(cells.some(isUnreviewedMaintenance), roleKey).toBe(false);
      for (const cell of cells.filter(isRecoveredTarget)) {
        expect({ mode: cell.mode, selector: cell.selector }, roleKey).toEqual({ mode: 'run', selector: 'all' });
        actual.add(targetCellIdentity({ legalEntityId, principalId, tenantId: demoTenantId }, cell));
      }
    }
    // In this producer, operations/provoz have only Tagging at 021. The separate Siampark reset grants
    // all eight at 020 to its account indexes 1 and 4, never to this producer's 021 recipes.
    expect([...actual].toSorted()).toEqual(expectedDemoTargetCells);
    const people = new Set(assignments.map(({ principalId }) => principalId));
    for (const machine of reviewedMachinePrincipals) {
      expect(people.has(machine.principalId)).toBe(false);
    }
    const serviceIds = new Set(reviewedMachinePrincipals.map(({ principalId }) => principalId));
    for (const binding of reviewedWorkloadBindings().filter(
      ({ workloadKey }) => workloadKey === 'commerce.storefront-client',
    )) {
      expect(serviceIds.has(binding.principalId)).toBe(true);
    }
  }).pipe(Effect.provide(NodeServices.layer)),
);

it.effect('keeps the playground AKROS restriction and the current owner human-only guard', () =>
  Effect.gen(function* playgroundAndCleanup() {
    const catalog = yield* release;
    expect(merchandiseRestrictedCompanyIds.every(isAkrosCompany)).toBe(true);
    expect(merchandiseRestrictedCompanyIds).toContain(AKROS_PLAYGROUND_LEGAL_ENTITY_ID);
    const role = reviewedCompanyRole(eshopDemoRoles.fulfilment, AKROS_PLAYGROUND_LEGAL_ENTITY_ID);
    const cells = yield* Effect.fromResult(policyRoleCellRows(role, catalog));
    expect(cells.some(({ capabilityKey }) => ordinary.some((key) => key === capabilityKey))).toBe(false);
    expect(cells.some(({ capabilityKey }) => capabilityKey === markets || capabilityKey === cleanup)).toBe(false);
    yield* assertCommandAllowed('human', 'AiDecideChanges');
    expect(
      Schema.is(MerchandisePermissionDenied)(yield* Effect.flip(assertCommandAllowed('non_human', 'AiDecideChanges'))),
    ).toBe(true);
    const missingCompany = yield* Effect.fromResult(
      policyRoleCellRows(reviewedCompanyRole(eshopDemoRoles.fulfilment), catalog),
    );
    expect(
      missingCompany.some(({ capabilityKey }) =>
        [...operations, ...ordinary, proposal, markets, cleanup].some((key) => key === capabilityKey),
      ),
    ).toBe(false);
  }).pipe(Effect.provide(NodeServices.layer)),
);

it.effect('publishes the exact source whitelist with RUN-only company cells and no workload assignments', () =>
  Effect.gen(function* bootstrapSourceRestrictions() {
    const modules = yield* readAccessCatalogArtifact(fileURLToPath(new URL('../..', import.meta.url)));
    const actual = new Set<string>();
    const checkedTenants: string[] = [];
    yield* bootstrapDemoPermissionContexts(modules, (context) =>
      Effect.sync(() => {
        checkedTenants.push(context.tenant.tenantId);
        for (const role of context.access.roles) {
          expect(role.cells.some(isUnreviewedMaintenance), role.key).toBe(false);
          for (const cell of role.cells.filter(isRecoveredTarget)) {
            expect({ mode: cell.mode, selector: cell.selector }, role.key).toEqual({ mode: 'run', selector: 'all' });
          }
        }
        const workloads = new Set(context.access.workloads.map(({ principalId }) => principalId));
        for (const assignment of context.access.assignments) {
          expect(workloads.has(assignment.principalId), assignment.roleKey).toBe(false);
          const role = context.access.roles.find(({ key }) => key === assignment.roleKey);
          expect(role, assignment.roleKey).toBeDefined();
          expect(role?.legalEntityId, assignment.roleKey).toBe(assignment.legalEntityId);
          for (const cell of role?.cells.filter(isRecoveredTarget) ?? []) {
            actual.add(
              targetCellIdentity(
                {
                  legalEntityId: assignment.legalEntityId,
                  principalId: assignment.principalId,
                  tenantId: context.tenant.tenantId,
                },
                cell,
              ),
            );
          }
        }
        if (context.tenant.tenantId === demoTenantId) {
          const assignments = context.access.assignments.filter(({ roleKey }) => roleKey.includes('fulfilment'));
          expect(new Set(assignments.map(({ legalEntityId }) => legalEntityId))).toEqual(
            new Set([akrosDemoLegalEntityId, eshopDemoLegalEntityId]),
          );
        }
      }),
    );
    expect(checkedTenants).toContain(demoTenantId);
    // Comparing every emitted tenant/company/principal catches foreign scopes and proposal/approval cells.
    expect([...actual].toSorted()).toEqual(expectedDemoTargetCells);
  }).pipe(Effect.provide(NodeServices.layer)),
);
