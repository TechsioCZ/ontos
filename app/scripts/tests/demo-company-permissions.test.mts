import {
  toContextPermissionAccessObjectId,
  toLegalEntityAccessObjectId,
  toModuleAccessObjectId,
} from '@app/core-runtime';
import { commercialDemoCompany, demoCompanyTenantId, rentalDemoCompany } from '@app/core-runtime/demo-company-profiles';
import { expect, it } from 'effect-rstest';
import { Effect, Predicate, Schema } from 'effect';
import { HttpClient, HttpClientResponse } from 'effect/http';
import { toScopedRoleObjectId } from '../../packages/core-runtime/src/permissions/scoped-role.ts';
import {
  toSpiceDbActionObjectId,
  toSpiceDbActionGrantObjectId,
} from '../../packages/core-runtime/src/permissions/service.ts';
import { toIdentityNamespaceAccessObjectId } from '../../packages/core-runtime/src/permissions/context-access.ts';
import {
  akrosDemoLegalEntityId,
  crmDemoLegalEntityId,
  demoLegalEntityId,
  demoTenantId,
  eshopDemoLegalEntityId,
  rentalDemoLegalEntityId,
} from '../demo/fixture-ids.mts';
import {
  companyHumanAccounts,
  companyPermissionRelationships,
  crmPersonaPrincipalIds,
  demoHumanAccounts,
  demoPermissionRelationships,
  companyAdministratorWorkforceRelationships,
  demoCompanyMemberships,
  demoPrincipalRoleKey,
  principalRelationships,
  reviewedHumanActionAddonRelationships,
  ReviewedDemoActionMissing,
  privacyMarketingOperator,
  siamparkRentalPersonas,
  storefrontPrincipal,
  moduleActions,
  commercePortalActionKeys,
  commercePortalPrincipal,
  commercePortalRelationships,
  privacyConsentAuthorityRelationships,
  privacyConsentPrincipal,
  crmIntakeActionKeys,
  crmIntakeLegalEntityIds,
  crmPartyIntakePrincipal,
  crmIntakeRelationships,
} from '../demo/permissions.mts';
import type { DemoAction, DemoPermissionInstallation, DemoRelationship } from '../demo/permissions.mts';

import {
  bootstrapDemoPermissionContexts,
  demoBootstrapCompanyRows,
  ensureDemoCompanies,
} from '../demo/reset-permissions.mts';
import { verificationContext } from '../demo/verification-context.mts';
import { administratorRelationships } from '../demo/accounts-admin-grants.mts';
import {
  commercePortalExternalIdentityDeployment,
  commercePortalReleaseSecrets,
  commercePortalVerificationWorkloadGrants,
} from '../demo/commerce-portal.mts';

const operationsModule = 'facility.operations';
const workforceModule = 'demo.workforce';
const workforceWriteAll = 'demo.workforce.write_all';
const rentalActivitiesActionKey = 'crm.activities.apply-command';

const identityModule = 'core.identity';
const partyModule = 'party.registry';
const merchandiseModule = 'demo.merchandise';
const portfolioModule = 'property.portfolio';
const billingModule = 'finance.billing';
const operationsWriteAll = 'facility.operations.write_all';

const companySuffix = '/demo-companies';
const shellOrigin = 'http://localhost:3020';
const privacyModule = 'privacy.core';
const commerceModule = 'commerce.customer-context';
const activitiesModule = 'crm.activities';
const inactiveState = 'inactive';
const privacySetupActionKeys = [
  'privacy.core.create-processing-purpose',
  'privacy.core.create-notice-version',
] as const;
const companyRole = (principalId: string, legalEntityId: string) =>
  toScopedRoleObjectId({ legalEntityId, roleKey: demoPrincipalRoleKey(principalId), tenantId: demoTenantId });
const tenantRole = (principalId: string) =>
  toScopedRoleObjectId({ roleKey: demoPrincipalRoleKey(principalId), tenantId: demoTenantId });
const actionDescriptor = (
  actionKey: string,
  owningModuleKey: string,
  legalEntityScope: DemoAction['legalEntityScope'] = 'required',
): DemoAction => ({ actionKey, legalEntityScope, owningModuleKey, provisioning: 'explicit' });
const identityActions = [
  actionDescriptor('core.identity.activate-principal-binding', identityModule, 'forbidden'),
  actionDescriptor('core.identity.change-principal-binding-status', identityModule, 'forbidden'),
  actionDescriptor('core.identity.reserve-principal-binding', identityModule, 'forbidden'),
];
const partyActions = [
  'party.registry.create-party',
  'party.registry.accept-retail-enrollment-evidence',
  'party.registry.counterparty-customer-onboard',
  'party.registry.add-contact-point',
  'party.registry.update-party',
  'party.registry.update-contact-point',
  'party.registry.resolve-duplicate-candidate-create',
  'party.registry.archive-party',
  'party.registry.create-party-relationship',
].map((key) => actionDescriptor(key, partyModule));
const privacyActions = [
  ...privacySetupActionKeys,
  'privacy.core.record-consent-decision',
  'privacy.core.consent-self-service',
  'privacy.core.record-notice-provision',
  'privacy.core.create-privacy-subject',
].map((key) => actionDescriptor(key, privacyModule));
const commerceActions = [
  'commerce.customer-context.ensure-retail-customer-profile',
  'commerce.customer-context.bind-retail-portal-profile',
  'commerce.customer-context.claim-portal-enrollment-transition',
  'commerce.customer-context.record-portal-enrollment-outcome',
].map((key) => actionDescriptor(key, commerceModule));
const descriptors = [
  ...identityActions,
  ...partyActions,
  ...privacyActions,
  ...commerceActions,
  actionDescriptor('demo.crm.apply-command', 'demo.crm'),
];
// Explicit test publication and persisted installation; role policy is not installation evidence.
const publishedModuleKeys = [partyModule, privacyModule, commerceModule, 'demo.crm'];
const installation: DemoPermissionInstallation = {
  companies: [
    demoLegalEntityId,
    rentalDemoLegalEntityId,
    crmDemoLegalEntityId,
    eshopDemoLegalEntityId,
    akrosDemoLegalEntityId,
  ].map((legalEntityId) => ({ legalEntityId, status: 'active', tenantId: demoTenantId })),
  moduleStates: publishedModuleKeys.map((moduleKey) => ({ moduleKey, state: 'active', tenantId: demoTenantId })),
  publishedModuleKeys,
};
const relationships = demoPermissionRelationships(descriptors, installation);
const [administrator, salesRep, accountant, warehouse] = demoHumanAccounts;

const hasModule = (principalId: string, legalEntityId: string, moduleId: string) =>
  relationships.some(
    (row) =>
      row.resourceType === 'module_access' &&
      row.resourceId === toModuleAccessObjectId(demoTenantId, legalEntityId, moduleId) &&
      row.relation === 'accessor_role' &&
      row.subjectId === companyRole(principalId, legalEntityId) &&
      row.subjectRelation === 'member',
  );
const hasPermission = (principalId: string, legalEntityId: string, moduleId: string, permission: string) =>
  relationships.some(
    (row) =>
      row.resourceType === 'context_permission' &&
      row.resourceId === toContextPermissionAccessObjectId(demoTenantId, legalEntityId, { moduleId, permission }) &&
      row.relation === 'role_grantee' &&
      row.subjectId === companyRole(principalId, legalEntityId) &&
      row.subjectRelation === 'member',
  );
const grantsFor = (rows: readonly DemoRelationship[], principalId: string) => {
  const roles = new Set(
    rows
      .filter((row) => row.resourceType === 'scoped_role' && row.relation === 'member' && row.subjectId === principalId)
      .map((row) => row.resourceId),
  );
  return rows.filter(
    (row) =>
      row.resourceType === 'action_grant' &&
      row.relation === 'role' &&
      row.subjectRelation === 'member' &&
      roles.has(row.subjectId),
  );
};
const actionScope = (action: DemoAction, legalEntityId: string) =>
  action.legalEntityScope === 'forbidden'
    ? { actionKey: action.actionKey, tenantId: demoTenantId }
    : { actionKey: action.actionKey, legalEntityId, tenantId: demoTenantId };

type BootstrapContext = Parameters<Parameters<typeof bootstrapDemoPermissionContexts>[3]>[0];

// Model only the Core port boundary: committed insert-only module rows and a separate persisted read.
// This exercises the real producer, not PostgreSQL or the Core subprocess.
const bootstrapPermissions = (
  initial: DemoPermissionInstallation,
  actions: readonly DemoAction[] = descriptors,
  persistModules = true,
) =>
  Effect.gen(function* exercisesBootstrapPhases() {
    const moduleStates = new Map(initial.moduleStates.map((row) => [`${row.tenantId}/${row.moduleKey}`, row]));
    const contexts: BootstrapContext[] = [];
    const reads: DemoPermissionInstallation[] = [];
    const rows = yield* bootstrapDemoPermissionContexts(
      actions,
      initial.publishedModuleKeys,
      Effect.sync(() => {
        const persisted = { ...initial, moduleStates: [...moduleStates.values()] };
        reads.push(persisted);
        return persisted;
      }),
      (context) =>
        Effect.sync(() => {
          contexts.push(context);
          if (!persistModules) {
            return;
          }
          for (const { moduleId } of context.modules) {
            const key = `${context.tenant.tenantId}/${moduleId}`;
            if (!moduleStates.has(key)) {
              moduleStates.set(key, { moduleKey: moduleId, state: 'active', tenantId: context.tenant.tenantId });
            }
          }
        }),
    );
    return { contexts, moduleStates: [...moduleStates.values()], reads, rows };
  });

const privacyTopology = (rows: readonly DemoRelationship[]) => {
  const actionIds = new Set(
    installation.companies.flatMap(({ legalEntityId }) =>
      privacyActions.map((action) => toSpiceDbActionObjectId(actionScope(action, legalEntityId))),
    ),
  );
  return rows.filter((row) => row.resourceType === 'action' && actionIds.has(row.resourceId));
};

it.effect('installs missing Privacy before deriving its exact scoped Action topology in one producer invocation', () =>
  Effect.gen(function* verifiesFreshBootstrap() {
    const initial = {
      ...installation,
      moduleStates: installation.moduleStates.filter((row) => row.moduleKey !== privacyModule),
    };
    const { contexts, reads, rows } = yield* bootstrapPermissions(initial);
    expect(reads).toHaveLength(1);
    expect(reads[0]?.moduleStates).toContainEqual({
      moduleKey: privacyModule,
      state: 'active',
      tenantId: demoTenantId,
    });
    expect(initial.moduleStates.some((row) => row.moduleKey === privacyModule)).toBe(false);
    expect(contexts).toHaveLength(3);
    expect(contexts[0]?.relationships).toEqual([]);
    expect(contexts[0]?.modules.some(({ moduleId }) => moduleId === privacyModule)).toBe(true);
    expect(contexts[1]?.modules).toEqual([]);
    expect(contexts[1]?.relationships).toEqual(rows);
    expect(contexts[2]).toEqual(yield* verificationContext(descriptors));
    const expected = installation.companies.flatMap(({ legalEntityId }) =>
      privacyActions.flatMap((action) => {
        const scope = actionScope(action, legalEntityId);
        return [
          {
            relation: 'company_scope',
            resourceId: toSpiceDbActionObjectId(scope),
            resourceType: 'action',
            subjectId: toLegalEntityAccessObjectId(demoTenantId, legalEntityId),
            subjectType: 'legal_entity',
          },
          {
            relation: 'grant',
            resourceId: toSpiceDbActionObjectId(scope),
            resourceType: 'action',
            subjectId: toSpiceDbActionGrantObjectId(scope),
            subjectType: 'action_grant',
          },
        ];
      }),
    );
    expect(privacyTopology(rows)).toHaveLength(expected.length);
    expect(new Set(privacyTopology(rows).map((row) => JSON.stringify(row)))).toEqual(
      new Set(expected.map((row) => JSON.stringify(row))),
    );
    const operatorRole = companyRole(privacyMarketingOperator.principalId, privacyMarketingOperator.legalEntityId);
    const privacyGrantIds = new Set(
      privacyActions.map((action) =>
        toSpiceDbActionGrantObjectId(actionScope(action, privacyMarketingOperator.legalEntityId)),
      ),
    );
    expect(
      grantsFor(rows, privacyMarketingOperator.principalId)
        .filter((row) => privacyGrantIds.has(row.resourceId))
        .map((row) => row.resourceId),
    ).toEqual(
      privacySetupActionKeys.map((actionKey) =>
        toSpiceDbActionGrantObjectId({
          actionKey,
          legalEntityId: privacyMarketingOperator.legalEntityId,
          tenantId: demoTenantId,
        }),
      ),
    );
    // All named grants are exact: existing operational permissions plus only two Privacy reads, no Privacy write.
    const operatorPermissions = rows.filter(
      (row) =>
        row.subjectId === operatorRole && row.resourceType === 'context_permission' && row.relation === 'role_grantee',
    );
    const expectedPermissions = [
      [merchandiseModule, 'demo.merchandise.read_all'],
      [merchandiseModule, 'demo.merchandise.write_all'],
      ['work.tasks', 'work.tasks.read_all'],
      ['work.tasks', 'work.tasks.write_all'],
      [workforceModule, 'demo.workforce.read_all'],
      [workforceModule, workforceWriteAll],
      ['demo.tagging', 'demo.tagging.read_all'],
      [privacyModule, 'privacy.processing_catalog.read'],
      [privacyModule, 'privacy.notice.read'],
    ] as const;
    expect(operatorPermissions).toHaveLength(expectedPermissions.length);
    expect(new Set(operatorPermissions.map((row) => row.resourceId))).toEqual(
      new Set(
        expectedPermissions.map(([moduleId, permission]) =>
          toContextPermissionAccessObjectId(demoTenantId, privacyMarketingOperator.legalEntityId, {
            moduleId,
            permission,
          }),
        ),
      ),
    );
  }),
);

it.effect('does not reactivate inactive Privacy or install topology without publication or persisted activation', () =>
  Effect.gen(function* verifiesUnavailablePrivacy() {
    const inactive = {
      ...installation,
      moduleStates: installation.moduleStates.map((row) =>
        row.moduleKey === privacyModule ? { ...row, state: inactiveState } : row,
      ),
    };
    for (const [initial, persistModules] of [
      [inactive, true],
      [{ ...installation, publishedModuleKeys: publishedModuleKeys.filter((key) => key !== privacyModule) }, true],
      [{ ...installation, moduleStates: [] }, false],
    ] as const) {
      const { contexts, reads, rows } = yield* bootstrapPermissions(initial, descriptors, persistModules);
      expect(privacyTopology(rows)).toEqual([]);
      expect(rows).toEqual(demoPermissionRelationships(descriptors, reads[0] ?? initial));
      expect(contexts[2]).toEqual(yield* verificationContext(descriptors));
    }
    const { moduleStates } = yield* bootstrapPermissions(inactive);
    expect(moduleStates.find((row) => row.moduleKey === privacyModule && row.tenantId === demoTenantId)?.state).toBe(
      inactiveState,
    );
  }),
);

it.effect('conserves unrelated company, role and rental Activities relationships across fresh Privacy activation', () =>
  Effect.gen(function* verifiesConservedAuthorization() {
    const activitiesAction = actionDescriptor(rentalActivitiesActionKey, activitiesModule);
    const actions = [...descriptors, activitiesAction];
    const initial = {
      ...installation,
      moduleStates: [
        ...installation.moduleStates.filter((row) => row.moduleKey !== privacyModule),
        { moduleKey: activitiesModule, state: 'active', tenantId: demoTenantId },
      ],
      publishedModuleKeys: [...publishedModuleKeys, activitiesModule],
    };
    const before = demoPermissionRelationships(actions, initial);
    const { rows } = yield* bootstrapPermissions(initial, actions);
    const privacyModules = installation.companies.map(({ legalEntityId }) => ({
      relation: 'legal_entity',
      resourceId: toModuleAccessObjectId(demoTenantId, legalEntityId, privacyModule),
      resourceType: 'module_access',
      subjectId: toLegalEntityAccessObjectId(demoTenantId, legalEntityId),
      subjectType: 'legal_entity',
    }));
    // Installation may add Privacy module structure as well as Action structure, never role authority.
    expect(new Set(rows.map((row) => JSON.stringify(row)))).toEqual(
      new Set([...before, ...privacyTopology(rows), ...privacyModules].map((row) => JSON.stringify(row))),
    );
    const activityScope = actionScope(activitiesAction, rentalDemoLegalEntityId);
    expect(rows).toContainEqual({
      relation: 'grant',
      resourceId: toSpiceDbActionObjectId(activityScope),
      resourceType: 'action',
      subjectId: toSpiceDbActionGrantObjectId(activityScope),
      subjectType: 'action_grant',
    });
  }),
);

it.effect('stops before reading installation or writing policy when native identity activation fails', () =>
  Effect.gen(function* verifiesBootstrapFailure() {
    let reads = 0;
    let writes = 0;
    const activationFailure = new Error('Native activation failed');
    const failure = yield* Effect.flip(
      bootstrapDemoPermissionContexts(
        descriptors,
        publishedModuleKeys,
        Effect.sync(() => {
          reads += 1;
          return installation;
        }),
        () => {
          writes += 1;
          return Effect.fail(activationFailure);
        },
      ),
    );
    expect(failure).toBe(activationFailure);
    expect(reads).toBe(0);
    expect(writes).toBe(1);
  }),
);

it('retains stable fixture IDs and explicit human affiliations, never deriving membership from service roles', () => {
  expect(demoTenantId).toBe(demoCompanyTenantId);
  expect(demoLegalEntityId).toBe(commercialDemoCompany.legalEntityId);
  expect(rentalDemoLegalEntityId).toBe(rentalDemoCompany.legalEntityId);
  expect(
    demoCompanyMemberships.find((row) => row.principalId === siamparkRentalPersonas[3].principalId)?.affiliation,
  ).toBe('external');
  expect(demoCompanyMemberships.some((row) => row.principalId === storefrontPrincipal.principalId)).toBe(false);
  expect(demoCompanyMemberships.filter((row) => row.principalId === warehouse.principalId)).toHaveLength(1);
});

it('seeds every membership company before bootstrap on a fresh baseline, without waiting for the company Action', () => {
  // The full Nájempark reset creates only the commercial company; permissions must supply the remaining targets.
  const baselineCompanyIds = new Set<string>([commercialDemoCompany.legalEntityId]);
  for (const membership of demoCompanyMemberships) {
    if (!baselineCompanyIds.has(membership.legalEntityId)) {
      expect(demoBootstrapCompanyRows.find((row) => row.legalEntityId === membership.legalEntityId)).toMatchObject({
        status: 'active',
        tenantId: demoTenantId,
      });
    }
  }
  expect(demoBootstrapCompanyRows.find((row) => row.legalEntityId === rentalDemoLegalEntityId)).toEqual({
    ...rentalDemoCompany,
    registrationCountry: 'CZ',
    registrationNumber: 'DEMO-SIAMPARK-RENTAL',
    status: 'active',
    tenantId: demoTenantId,
  });
});

it('separates commercial stock, rental property, and warehouse membership through exact company roles', () => {
  expect(hasModule(administrator.principalId, demoLegalEntityId, merchandiseModule)).toBe(true);
  expect(hasModule(administrator.principalId, demoLegalEntityId, portfolioModule)).toBe(false);
  expect(hasModule(administrator.principalId, rentalDemoLegalEntityId, merchandiseModule)).toBe(false);
  expect(hasModule(administrator.principalId, rentalDemoLegalEntityId, portfolioModule)).toBe(true);
  expect(hasModule(salesRep.principalId, rentalDemoLegalEntityId, workforceModule)).toBe(true);
  expect(hasModule(accountant.principalId, rentalDemoLegalEntityId, billingModule)).toBe(true);
  expect(
    relationships.some(
      (row) =>
        row.resourceType === 'legal_entity' &&
        row.resourceId === toLegalEntityAccessObjectId(demoTenantId, rentalDemoLegalEntityId) &&
        row.relation === 'member' &&
        row.subjectId === warehouse.principalId,
    ),
  ).toBe(false);
});

it('assigns one explicit tenant superadmin and keeps named company administrators out of tenant administration', () => {
  const superadmin = toScopedRoleObjectId({ roleKey: 'superadmin', tenantId: demoTenantId });
  expect(
    relationships
      .filter((row) => row.resourceType === 'scoped_role' && row.resourceId === superadmin && row.relation === 'member')
      .map((row) => row.subjectId),
  ).toEqual([administrator.principalId]);
  expect(relationships.filter((row) => row.relation === 'identity_admin')).toEqual([]);
  for (const account of companyHumanAccounts.filter(
    (row) => row.role === 'crmAdmin' || row.role === 'akrosAdmin' || row.role === 'eshopAdmin',
  )) {
    const roleId = toScopedRoleObjectId({
      legalEntityId: account.legalEntityId,
      roleKey: 'admin',
      tenantId: demoTenantId,
    });
    expect(
      relationships.some(
        (row) => row.resourceId === roleId && row.relation === 'member' && row.subjectId === account.principalId,
      ),
    ).toBe(true);
    expect(relationships.some((row) => row.resourceId === superadmin && row.subjectId === account.principalId)).toBe(
      false,
    );
  }
  expect(
    relationships
      .filter((row) => row.subjectType === 'principal')
      .every(
        (row) =>
          (row.relation === 'member' && ['tenant', 'legal_entity', 'scoped_role'].includes(row.resourceType)) ||
          (row.resourceType === 'tenant' && row.relation === 'company_member'),
      ),
  ).toBe(true);
  const selectedActors = new Set(demoCompanyMemberships.map(({ principalId }) => principalId));
  for (const row of relationships.filter(
    (item) => item.resourceType === 'tenant' && item.subjectType === 'principal',
  )) {
    expect(row.relation).toBe(selectedActors.has(row.subjectId) ? 'company_member' : 'member');
  }
  expect(new Set(relationships.map((row) => JSON.stringify(row))).size).toBe(relationships.length);
});

it('repairs administrators as scoped roles without global Action grants or direct principal capabilities', () => {
  const rows = administratorRelationships();
  expect(rows.some((row) => row.resourceType === 'action' || row.relation === 'identity_admin')).toBe(false);
  expect(rows.filter((row) => row.relation === 'admin')).toHaveLength(5);
  expect(rows.filter((row) => row.relation === 'superadmin')).toHaveLength(1);
});

it('gives company administrators Workforce writes through their exact admin role in every seeded company', () => {
  for (const legalEntityId of [
    demoLegalEntityId,
    rentalDemoLegalEntityId,
    crmDemoLegalEntityId,
    eshopDemoLegalEntityId,
    akrosDemoLegalEntityId,
  ]) {
    const adminRole = toScopedRoleObjectId({ legalEntityId, roleKey: 'admin', tenantId: demoTenantId });
    const policy = companyAdministratorWorkforceRelationships(legalEntityId);
    expect(policy.length).toBeGreaterThan(0);
    for (const row of policy) {
      expect(relationships).toContainEqual(row);
    }
    expect(policy).toContainEqual({
      relation: 'role_grantee',
      resourceId: toContextPermissionAccessObjectId(demoTenantId, legalEntityId, {
        moduleId: workforceModule,
        permission: workforceWriteAll,
      }),
      resourceType: 'context_permission',
      subjectId: adminRole,
      subjectRelation: 'member',
      subjectType: 'scoped_role',
    });
    // Policy-only reconciliation cannot grant a role to a zero-role member or resurrect a removed membership.
    expect(policy.some((row) => row.subjectType === 'principal' || row.resourceType === 'scoped_role')).toBe(false);
    expect(
      policy
        .filter((row) => row.subjectType === 'scoped_role')
        .every((row) => row.subjectId === adminRole && row.subjectRelation === 'member'),
    ).toBe(true);
    const otherCompany = legalEntityId === demoLegalEntityId ? rentalDemoLegalEntityId : demoLegalEntityId;
    expect(
      policy.some(
        (row) =>
          row.subjectId ===
          toScopedRoleObjectId({ legalEntityId: otherCompany, roleKey: 'admin', tenantId: demoTenantId }),
      ),
    ).toBe(false);
  }
});

it('does not promote rental operators, salespeople or membership-only principals to Workforce writers', () => {
  for (const principalId of [
    salesRep.principalId,
    ...siamparkRentalPersonas.slice(1).map((persona) => persona.principalId),
  ]) {
    expect(hasPermission(principalId, rentalDemoLegalEntityId, workforceModule, workforceWriteAll)).toBe(false);
    const adminRole = toScopedRoleObjectId({
      legalEntityId: rentalDemoLegalEntityId,
      roleKey: 'admin',
      tenantId: demoTenantId,
    });
    expect(
      relationships.some(
        (row) => row.resourceType === 'scoped_role' && row.resourceId === adminRole && row.subjectId === principalId,
      ),
    ).toBe(false);
  }
  expect(
    relationships
      .filter((row) => row.subjectType === 'principal')
      .every((row) => ['member', 'company_member'].includes(row.relation)),
  ).toBe(true);
});

it('keeps CRM and e-shop personas inside their own company with role-specific CRM visibility', () => {
  for (const account of [...companyHumanAccounts, storefrontPrincipal]) {
    expect(
      relationships
        .filter(
          (row) =>
            row.resourceType === 'legal_entity' && row.relation === 'member' && row.subjectId === account.principalId,
        )
        .map((row) => row.resourceId),
    ).toEqual([toLegalEntityAccessObjectId(demoTenantId, account.legalEntityId)]);
  }
  expect(hasModule(crmPersonaPrincipalIds.repA, crmDemoLegalEntityId, 'demo.crm')).toBe(true);
  expect(hasModule(crmPersonaPrincipalIds.repA, crmDemoLegalEntityId, partyModule)).toBe(false);
  expect(hasModule(storefrontPrincipal.principalId, eshopDemoLegalEntityId, merchandiseModule)).toBe(true);
  expect(hasModule(storefrontPrincipal.principalId, eshopDemoLegalEntityId, partyModule)).toBe(false);
  expect(hasPermission(crmPersonaPrincipalIds.manager, crmDemoLegalEntityId, 'demo.crm', 'demo.crm.read_all')).toBe(
    true,
  );
  expect(hasPermission(crmPersonaPrincipalIds.repA, crmDemoLegalEntityId, 'demo.crm', 'demo.crm.read_all')).toBe(false);
  expect(hasPermission(crmPersonaPrincipalIds.repB, crmDemoLegalEntityId, 'demo.crm', 'demo.crm.read_assigned')).toBe(
    true,
  );
});

it.effect('defers company setup while the demo shell is offline, then uses its audited Core Action', () =>
  Effect.gen(function* operatorCompanySetup() {
    const requests: string[] = [];
    let online = false;
    const client = HttpClient.make((request, url) => {
      requests.push(`${request.method} ${url.pathname}`);
      const body = url.pathname.endsWith(companySuffix)
        ? {
            companies: [
              { legalEntityId: demoLegalEntityId, legalName: 'Obchodní firma' },
              { legalEntityId: rentalDemoLegalEntityId, legalName: 'Nájempark' },
            ],
          }
        : {};
      if (url.pathname.endsWith(companySuffix)) {
        expect(request.headers['idempotency-key']).toMatch(/^sales-demo-companies-/u);
        expect(request.headers.cookie).toContain('fixture-session');
      }
      return Effect.succeed(
        HttpClientResponse.fromWeb(
          request,
          Response.json(body, {
            headers: { 'set-cookie': 'fixture-session=operator; Path=/' },
            status: online ? 200 : 503,
          }),
        ),
      );
    });
    yield* ensureDemoCompanies(shellOrigin).pipe(Effect.provideService(HttpClient.HttpClient, client));
    expect(requests).toHaveLength(1);
    online = true;
    yield* ensureDemoCompanies(shellOrigin).pipe(Effect.provideService(HttpClient.HttpClient, client));
    expect(requests).toEqual([
      'GET /.well-known/ontos-shell-runtime.json',
      'GET /.well-known/ontos-shell-runtime.json',
      'POST /shell-super-app-api/auth/sign-in',
      'POST /shell-super-app-api/auth/identity/demo-companies',
    ]);
  }),
);

it.effect('fails demo startup when the company Action is denied instead of declaring both companies ready', () =>
  Effect.gen(function* deniedSetup() {
    const client = HttpClient.make((request, url) =>
      Effect.succeed(
        HttpClientResponse.fromWeb(
          request,
          Response.json(
            {},
            {
              status: url.pathname.endsWith(companySuffix) ? 403 : 200,
            },
          ),
        ),
      ),
    );
    const failure = yield* ensureDemoCompanies(shellOrigin).pipe(
      Effect.provideService(HttpClient.HttpClient, client),
      Effect.flip,
    );
    expect(Predicate.isTagged(failure, 'DemoPermissionsError')).toBe(true);
  }),
);

it('limits the external Nájempark role to real operational/assigned-only permissions', () => {
  const [management, , finance, external] = siamparkRentalPersonas;
  expect(hasModule(management.principalId, rentalDemoLegalEntityId, portfolioModule)).toBe(true);
  expect(hasPermission(management.principalId, rentalDemoLegalEntityId, operationsModule, operationsWriteAll)).toBe(
    true,
  );
  expect(hasModule(finance.principalId, rentalDemoLegalEntityId, billingModule)).toBe(true);
  expect(hasModule(external.principalId, rentalDemoLegalEntityId, billingModule)).toBe(false);
  expect(
    hasPermission(
      external.principalId,
      rentalDemoLegalEntityId,
      operationsModule,
      'facility.operations.read_operational',
    ),
  ).toBe(true);
  for (const permission of [
    'facility.operations.read_all',
    operationsWriteAll,
    'facility.operations.write_operational',
  ]) {
    expect(hasPermission(external.principalId, rentalDemoLegalEntityId, operationsModule, permission)).toBe(false);
  }
});

it('grants Activities reads, writes and its installed Action only to rental management, not other personas or companies', () => {
  const activitiesAction = actionDescriptor(rentalActivitiesActionKey, activitiesModule);
  const activityInstallation = {
    ...installation,
    moduleStates: [
      ...installation.moduleStates,
      { moduleKey: activitiesModule, state: 'active' as const, tenantId: demoTenantId },
    ],
    publishedModuleKeys: [...installation.publishedModuleKeys, activitiesModule],
  };
  const rows = demoPermissionRelationships([...descriptors, activitiesAction], activityInstallation);
  const [management] = siamparkRentalPersonas;
  expect(management.principalId).toBe('72000000-0000-4000-8000-000000000021');
  expect(rentalDemoLegalEntityId).toBe('71000000-0000-4000-8000-000000000021');
  const roleId = companyRole(management.principalId, rentalDemoLegalEntityId);
  const moduleIds = new Set(
    installation.companies.map(({ legalEntityId }) =>
      toModuleAccessObjectId(demoTenantId, legalEntityId, activitiesModule),
    ),
  );
  const permissionIds = new Set(
    installation.companies.flatMap(({ legalEntityId }) =>
      ['crm.activities.read_all', 'crm.activities.write_all'].map((permission) =>
        toContextPermissionAccessObjectId(demoTenantId, legalEntityId, { moduleId: activitiesModule, permission }),
      ),
    ),
  );
  const actionGrantIds = new Set(
    installation.companies.map(({ legalEntityId }) =>
      toSpiceDbActionGrantObjectId(actionScope(activitiesAction, legalEntityId)),
    ),
  );
  const roleGrant = { subjectId: roleId, subjectRelation: 'member', subjectType: 'scoped_role' };
  expect(
    rows.filter(
      (row) =>
        row.resourceType === 'module_access' && row.relation === 'accessor_role' && moduleIds.has(row.resourceId),
    ),
  ).toEqual([
    {
      ...roleGrant,
      relation: 'accessor_role',
      resourceId: toModuleAccessObjectId(demoTenantId, rentalDemoLegalEntityId, activitiesModule),
      resourceType: 'module_access',
    },
  ]);
  expect(
    rows.filter(
      (row) =>
        row.resourceType === 'context_permission' &&
        row.relation === 'role_grantee' &&
        permissionIds.has(row.resourceId),
    ),
  ).toEqual(
    ['crm.activities.read_all', 'crm.activities.write_all'].map((permission) => ({
      ...roleGrant,
      relation: 'role_grantee',
      resourceId: toContextPermissionAccessObjectId(demoTenantId, rentalDemoLegalEntityId, {
        moduleId: activitiesModule,
        permission,
      }),
      resourceType: 'context_permission',
    })),
  );
  const actionIdentity = actionScope(activitiesAction, rentalDemoLegalEntityId);
  expect(
    rows.filter(
      (row) => row.resourceType === 'action_grant' && row.relation === 'role' && actionGrantIds.has(row.resourceId),
    ),
  ).toEqual([
    {
      ...roleGrant,
      relation: 'role',
      resourceId: toSpiceDbActionGrantObjectId(actionIdentity),
      resourceType: 'action_grant',
    },
  ]);
  expect(rows).toContainEqual({
    relation: 'grant',
    resourceId: toSpiceDbActionObjectId(actionIdentity),
    resourceType: 'action',
    subjectId: toSpiceDbActionGrantObjectId(actionIdentity),
    subjectType: 'action_grant',
  });
  // Catalog installation adds topology, not grants for baseline 0020, other companies or the shared rental roles.
  const activityResourceIds = new Set([
    ...moduleIds,
    ...permissionIds,
    ...actionGrantIds,
    ...installation.companies.map(({ legalEntityId }) =>
      toSpiceDbActionObjectId(actionScope(activitiesAction, legalEntityId)),
    ),
  ]);
  expect(rows.filter((row) => !activityResourceIds.has(row.resourceId))).toEqual(
    relationships.filter((row) => !activityResourceIds.has(row.resourceId)),
  );
});

it('uses descriptor ownership instead of Action-key prefixes and grants optional Actions only in the selected company', () => {
  const misleading = actionDescriptor('demo.crm.looks-owned', partyModule, 'optional');
  expect(moduleActions([misleading], 'demo.crm')).toEqual([]);
  const rows = principalRelationships(
    salesRep.principalId,
    { label: 'Test role', modules: { [partyModule]: 'write' } },
    [misleading],
    crmDemoLegalEntityId,
  );
  expect(grantsFor(rows, salesRep.principalId).map((row) => row.resourceId)).toEqual([
    toSpiceDbActionGrantObjectId(actionScope(misleading, crmDemoLegalEntityId)),
  ]);
  expect(rows.some((row) => row.resourceType === 'action' && row.relation === 'tenant_scope')).toBe(false);
});

it('provisions only the portal identity namespace role and exact tenant-scoped binding Actions', () => {
  const rows = commercePortalRelationships(identityActions);
  const namespace = toIdentityNamespaceAccessObjectId(demoTenantId, 'ontos.commerce.portal.better-auth.v1');
  expect(rows.filter((row) => row.resourceType === 'identity_namespace' && row.relation === 'provisioner')).toEqual([
    {
      relation: 'provisioner',
      resourceId: namespace,
      resourceType: 'identity_namespace',
      subjectId: companyRole(commercePortalPrincipal.principalId, akrosDemoLegalEntityId),
      subjectRelation: 'member',
      subjectType: 'scoped_role',
    },
  ]);
  const grants = grantsFor(rows, commercePortalPrincipal.principalId);
  expect(grants).toHaveLength(3);
  expect(grants.every((row) => row.subjectId === tenantRole(commercePortalPrincipal.principalId))).toBe(true);
  expect(
    rows.some((row) => row.relation === 'identity_admin' || row.relation === 'superadmin' || row.relation === 'admin'),
  ).toBe(false);
});

it('preserves the exact Commerce allowlist and company isolation without granting Party archive/merge/reviewer authority', () => {
  const rows = commercePortalRelationships(descriptors);
  expect(grantsFor(rows, commercePortalPrincipal.principalId).map((row) => row.resourceId)).toEqual(
    descriptors
      .filter((action) => commercePortalActionKeys.includes(action.actionKey))
      .map((action) => toSpiceDbActionGrantObjectId(actionScope(action, akrosDemoLegalEntityId))),
  );
  expect(rows.some((row) => row.relation === 'party_identity_manager' && row.subjectRelation === 'member')).toBe(true);
  expect(rows.some((row) => row.relation === 'party_identity_reviewer' || row.relation === 'identity_admin')).toBe(
    false,
  );
  expect(
    rows.filter((row) => row.resourceType === 'legal_entity' && row.relation === 'member').map((row) => row.resourceId),
  ).toEqual([toLegalEntityAccessObjectId(demoTenantId, akrosDemoLegalEntityId)]);
  expect(rows.some((row) => row.relation === 'executor' || row.relation === 'restriction')).toBe(false);
  expect(new Set(rows.map((row) => JSON.stringify(row))).size).toBe(rows.length);
});

it('grants the CRM intake only its five Actions in its two companies, never broad registry authority', () => {
  const rows = crmIntakeRelationships(descriptors);
  const allowed = descriptors.filter((action) => crmIntakeActionKeys.includes(action.actionKey));
  expect(grantsFor(rows, crmPartyIntakePrincipal.principalId).map((row) => row.resourceId)).toEqual(
    crmIntakeLegalEntityIds.flatMap((company) =>
      allowed.map((action) => toSpiceDbActionGrantObjectId(actionScope(action, company))),
    ),
  );
  expect(
    rows.some((row) => row.relation === 'admin' || row.relation === 'superadmin' || row.relation === 'identity_admin'),
  ).toBe(false);
  expect(
    rows
      .filter((row) => row.resourceType === 'action' && row.relation === 'company_scope')
      .every((row) =>
        crmIntakeLegalEntityIds.some((company) => row.subjectId === toLegalEntityAccessObjectId(demoTenantId, company)),
      ),
  ).toBe(true);
});

it('grants all native Privacy reads only through the Commerce company role, not a write or admin role', () => {
  const rows = commercePortalRelationships([]);
  const roleId = companyRole(commercePortalPrincipal.principalId, akrosDemoLegalEntityId);
  for (const permission of [
    'privacy.processing_catalog.read',
    'privacy.notice.read',
    'privacy.subjects.read',
    'privacy.consent.read',
  ]) {
    expect(
      rows.some(
        (row) =>
          row.resourceId ===
            toContextPermissionAccessObjectId(demoTenantId, akrosDemoLegalEntityId, {
              moduleId: privacyModule,
              permission,
            }) &&
          row.relation === 'role_grantee' &&
          row.subjectId === roleId,
      ),
    ).toBe(true);
  }
  expect(grantsFor(rows, commercePortalPrincipal.principalId)).toEqual([]);
  expect(rows.some((row) => row.relation === 'admin' || row.relation === 'superadmin')).toBe(false);
});

it('declares only Privacy setup Actions for the explicit company operator and never grants tenant administration', () => {
  const rows = companyPermissionRelationships(privacyActions);
  const operator = privacyMarketingOperator;
  expect(grantsFor(rows, operator.principalId).map((row) => row.resourceId)).toEqual(
    privacySetupActionKeys.map((actionKey) =>
      toSpiceDbActionGrantObjectId({ actionKey, legalEntityId: operator.legalEntityId, tenantId: demoTenantId }),
    ),
  );
  // Company admin intentionally has company-wide write_all; do not claim consent denial from this policy list.
  expect(rows.some((row) => row.relation === 'superadmin')).toBe(false);
});

it('grants the Privacy authority reader exactly two Commerce facts and no Actions or business-wide reads', () => {
  const rows = privacyConsentAuthorityRelationships(descriptors);
  expect(grantsFor(rows, privacyConsentPrincipal.principalId)).toEqual([]);
  expect(
    rows
      .filter((row) => row.resourceType === 'context_permission' && row.relation === 'role_grantee')
      .map((row) => row.resourceId),
  ).toEqual(
    ['customer.consent.resolve_authority', 'customer.notice.resolve_authority'].map((permission) =>
      toContextPermissionAccessObjectId(demoTenantId, privacyConsentPrincipal.legalEntityId, {
        moduleId: commerceModule,
        permission,
      }),
    ),
  );
  expect(
    rows.some((row) => row.relation === 'admin' || row.relation === 'superadmin' || row.relation === 'identity_admin'),
  ).toBe(false);
  expect(grantsFor(demoPermissionRelationships(privacyActions, installation), storefrontPrincipal.principalId)).toEqual(
    [],
  );
});

it('installs scoped Action/grant links, never blanket tenant membership Action grants', () => {
  const rows = commercePortalRelationships(descriptors);
  expect(
    rows
      .filter((row) => row.resourceType === 'action')
      .every((row) => ['company_scope', 'tenant_scope', 'grant'].includes(row.relation)),
  ).toBe(true);
  for (const action of descriptors.filter((entry) => commercePortalActionKeys.includes(entry.actionKey))) {
    const identity = actionScope(action, akrosDemoLegalEntityId);
    expect(
      rows.some(
        (row) =>
          row.resourceType === 'action' &&
          row.resourceId === toSpiceDbActionObjectId(identity) &&
          row.relation === 'grant' &&
          row.subjectId === toSpiceDbActionGrantObjectId(identity),
      ),
    ).toBe(true);
  }
});

it('grants only the exact portal workload on the owner verification audience', () => {
  expect(commercePortalVerificationWorkloadGrants()).toEqual({
    grants: [
      {
        commerceAuthenticationNamespaceId: 'ontos.commerce.portal.better-auth.v1',
        operation: 'commerce-portal-authentication.verify-external-authentication.v1',
        receivingAudience: 'shell-super-app',
        tenantId: demoTenantId,
        workloadAuthenticationNamespaceId: 'ontos.staff.better-auth.v1',
        workloadPrincipalId: commercePortalPrincipal.principalId,
      },
    ],
    providerEndpointAudience: 'commerce-customer-context',
  });
});

it.effect(
  'generates missing verification grants from the assembled Shell deployment, preserving all other secrets',
  () =>
    Effect.gen(function* generatedReleaseGrants() {
      const deployment = commercePortalExternalIdentityDeployment();
      const tenantId = '10000000-0000-4000-8000-000000000041';
      const workloadPrincipalId = '10000000-0000-4000-8000-000000000042';
      const stagedDeployment = {
        ...deployment,
        grants: deployment.grants.map((grant) => ({ ...grant, tenantId, workloadPrincipalId })),
      };
      const bundle = {
        'commerce-customer-context': { COMMERCE_CORE_IDENTITY_API_KEY: 'unit-only-secret' },
        'party-registry': { UNRELATED_SECRET: 'unit-only-party-secret' },
        'shell-super-app': {
          BETTER_AUTH_SECRET: 'unit-only-shell-secret',
          ONTOS_COMMERCE_EXTERNAL_IDENTITY_DEPLOYMENT: JSON.stringify(stagedDeployment),
        },
      };
      const result = yield* commercePortalReleaseSecrets(bundle);
      expect(result['commerce-customer-context']?.COMMERCE_CORE_IDENTITY_API_KEY).toBe('unit-only-secret');
      expect(result['party-registry']).toBe(bundle['party-registry']);
      expect(result['shell-super-app']).toBe(bundle['shell-super-app']);
      expect(Object.keys(bundle['commerce-customer-context'])).toEqual(['COMMERCE_CORE_IDENTITY_API_KEY']);
      const generated: unknown = JSON.parse(
        result['commerce-customer-context']?.COMMERCE_PORTAL_AUTH_VERIFICATION_WORKLOAD_GRANTS ?? 'null',
      );
      expect(generated).toEqual({
        grants: [
          {
            commerceAuthenticationNamespaceId: deployment.authenticationNamespaceId,
            operation: 'commerce-portal-authentication.verify-external-authentication.v1',
            receivingAudience: deployment.providerEndpointAudience,
            tenantId,
            workloadAuthenticationNamespaceId: stagedDeployment.grants[0]?.workloadAuthenticationNamespaceId,
            workloadPrincipalId,
          },
        ],
        providerEndpointAudience: 'commerce-customer-context',
      });
      const second = yield* commercePortalReleaseSecrets(result);
      expect(second).toEqual(result);
    }),
);

it.effect('replaces stale hand-copied verification grants with the canonical generated value', () =>
  Effect.gen(function* replacesStaleReleaseGrants() {
    const result = yield* commercePortalReleaseSecrets({
      'commerce-customer-context': { COMMERCE_PORTAL_AUTH_VERIFICATION_WORKLOAD_GRANTS: '{"grants":[]}' },
      'shell-super-app': {
        ONTOS_COMMERCE_EXTERNAL_IDENTITY_DEPLOYMENT: JSON.stringify(commercePortalExternalIdentityDeployment()),
      },
    });
    expect(result['commerce-customer-context']?.COMMERCE_PORTAL_AUTH_VERIFICATION_WORKLOAD_GRANTS).toBe(
      JSON.stringify(commercePortalVerificationWorkloadGrants()),
    );
  }),
);

it.effect('refuses release bundles without usable owner workload metadata rather than shipping deny-all defaults', () =>
  Effect.gen(function* rejectsMissingReleaseMetadata() {
    const deployment = commercePortalExternalIdentityDeployment();
    const invalidDeployments = [
      undefined,
      'not-json',
      JSON.stringify({ ...deployment, grants: [] }),
      JSON.stringify({ ...deployment, authenticationNamespaceId: 'foreign.portal.namespace' }),
      JSON.stringify({
        ...deployment,
        grants: deployment.grants.map((grant) => ({ ...grant, receivingAudience: 'foreign-receiver' })),
      }),
    ];
    for (const value of invalidDeployments) {
      const failure = yield* Effect.flip(
        commercePortalReleaseSecrets({
          'commerce-customer-context': {},
          'shell-super-app': value === undefined ? {} : { ONTOS_COMMERCE_EXTERNAL_IDENTITY_DEPLOYMENT: value },
        }),
      );
      expect(failure.reason).toBe('Commerce release secrets require valid Shell provider workload metadata');
    }
    const noCommerceUnit = yield* Effect.flip(
      commercePortalReleaseSecrets({
        'shell-super-app': { ONTOS_COMMERCE_EXTERNAL_IDENTITY_DEPLOYMENT: JSON.stringify(deployment) },
      }),
    );
    expect(noCommerceUnit.reason).toBe('Commerce release secrets require the Commerce and Shell units');
  }),
);
it.effect('restores only seven reviewed human executors in two separately scoped named add-ons', () =>
  Effect.gen(function* reviewedHumanExecutors() {
    const operational = [
      actionDescriptor(rentalActivitiesActionKey, 'crm.activities'),
      actionDescriptor('demo.workforce.apply-command', workforceModule),
      actionDescriptor('demo.merchandise.apply-command', merchandiseModule),
      actionDescriptor('demo.sales-insights.apply-command', 'demo.sales-insights'),
      actionDescriptor('finance.billing.apply-command', billingModule),
      actionDescriptor('property.portfolio.apply-command', portfolioModule),
    ];
    const leasing = actionDescriptor('property.leasing.apply-command', 'property.leasing');
    const rows = yield* reviewedHumanActionAddonRelationships([...operational, leasing, ...descriptors]);
    const operationsPerson = siamparkRentalPersonas[1].principalId;
    expect(new Set(grantsFor(rows, operationsPerson).map((row) => row.resourceId))).toEqual(
      new Set(operational.map((action) => toSpiceDbActionGrantObjectId(actionScope(action, rentalDemoLegalEntityId)))),
    );
    expect(grantsFor(rows, salesRep.principalId).map((row) => row.resourceId)).toEqual([
      toSpiceDbActionGrantObjectId(actionScope(leasing, demoLegalEntityId)),
    ]);
    expect(rows.filter((row) => row.resourceType === 'action_grant' && row.relation === 'role')).toHaveLength(7);
    expect(new Set(rows.filter((row) => row.resourceType === 'scoped_role').map((row) => row.resourceId))).toEqual(
      new Set([
        toScopedRoleObjectId({
          legalEntityId: rentalDemoLegalEntityId,
          roleKey: 'operations-execution',
          tenantId: demoTenantId,
        }),
        toScopedRoleObjectId({
          legalEntityId: demoLegalEntityId,
          roleKey: 'rental-sales-execution',
          tenantId: demoTenantId,
        }),
      ]),
    );
    expect(new Set(rows.filter((row) => row.resourceType === 'scoped_role').map((row) => row.subjectId))).toEqual(
      new Set([operationsPerson, salesRep.principalId]),
    );
    expect(rows.some((row) => row.resourceType === 'module_access' || row.resourceType === 'context_permission')).toBe(
      false,
    );
    const missing = yield* reviewedHumanActionAddonRelationships(operational).pipe(Effect.flip);
    expect(Schema.is(ReviewedDemoActionMissing)(missing)).toBe(true);
    expect(missing.message).toBe('Reviewed Action missing: property.leasing.apply-command');
  }),
);

it('uses only explicitly linked organizational names for demo logins and preserves unlinked names', () => {
  expect(demoHumanAccounts.map(({ displayName, email }) => [email, displayName])).toEqual([
    ['obchod@demo.ontos', 'Jana Nováková'],
    ['obchodnik@demo.ontos', 'Petr Svoboda'],
    ['ucetni@demo.ontos', 'Eva Veselá'],
    ['sklad@demo.ontos', 'Pavel Němec'],
  ]);
  expect(companyHumanAccounts.map(({ displayName, email }) => [email, displayName])).toEqual([
    ['spravce@hanak.demo', 'Karel Hanák'],
    ['vedouci@hanak.demo', 'Lucie Dvořáková'],
    ['obchodnik.a@hanak.demo', 'Jan Novák'],
    ['obchodnik.b@hanak.demo', 'Petra Svobodová'],
    ['eshop@kavarna.demo', 'Tereza Malá'],
    ['eshop@akros.demo', 'Správce e-shopu AKROS'],
    ['expedice@akros.demo', 'Expedice AKROS'],
    ['expedice@kavarna.demo', 'Ondřej Kříž'],
  ]);
});

it('includes every technical service grant in both transition and fresh-bootstrap authority', () => {
  const rows = demoPermissionRelationships(descriptors, installation);
  const services = [commercePortalPrincipal, privacyConsentPrincipal, crmPartyIntakePrincipal];
  const expected = [
    ...commercePortalRelationships(descriptors),
    ...privacyConsentAuthorityRelationships(descriptors),
    ...crmIntakeRelationships(descriptors),
  ];
  // Role producers contribute grants, not evidence that an Action is installed.
  for (const relationship of expected.filter((row) => row.resourceType !== 'action')) {
    expect(rows).toContainEqual(relationship);
  }
  for (const { principalId } of services) {
    expect(demoCompanyMemberships.some((membership) => membership.principalId === principalId)).toBe(false);
    expect(rows).toContainEqual({
      relation: 'member',
      resourceId: demoTenantId,
      resourceType: 'tenant',
      subjectId: principalId,
      subjectType: 'principal',
    });
    expect(rows.some((row) => row.subjectId === principalId && row.relation === 'company_member')).toBe(false);
  }
});
