import {
  toContextPermissionAccessObjectId,
  toLegalEntityAccessObjectId,
  toModuleAccessObjectId,
} from '@app/core-runtime';
import { commercialDemoCompany, demoCompanyTenantId, rentalDemoCompany } from '@app/core-runtime/demo-company-profiles';
import { expect, it } from 'effect-rstest';
import { Effect, Predicate } from 'effect';
import { HttpClient, HttpClientResponse } from 'effect/unstable/http';
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
import type { DemoAction, DemoRelationship } from '../demo/permissions.mts';

import { ensureDemoCompanies } from '../demo/reset-permissions.mts';
import { administratorRelationships } from '../demo/accounts-admin-grants.mts';
import {
  commercePortalExternalIdentityDeployment,
  commercePortalReleaseSecrets,
  commercePortalVerificationWorkloadGrants,
} from '../demo/commerce-portal.mts';

const operationsModule = 'facility.operations';
const workforceModule = 'demo.workforce';

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
  'privacy.core.create-processing-purpose',
  'privacy.core.create-notice-version',
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
const relationships = demoPermissionRelationships(descriptors);
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
        permission: 'demo.workforce.write_all',
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
    expect(hasPermission(principalId, rentalDemoLegalEntityId, workforceModule, 'demo.workforce.write_all')).toBe(
      false,
    );
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
              { legalEntityId: rentalDemoLegalEntityId, legalName: 'Siampark' },
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

it('limits the external Siampark role to real operational/assigned-only permissions', () => {
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
    ['privacy.core.create-processing-purpose', 'privacy.core.create-notice-version'].map((actionKey) =>
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
  expect(grantsFor(demoPermissionRelationships(privacyActions), storefrontPrincipal.principalId)).toEqual([]);
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
it('restores only seven reviewed human executors in two separately scoped named add-ons', () => {
  const operational = [
    actionDescriptor('crm.activities.apply-command', 'crm.activities'),
    actionDescriptor('demo.workforce.apply-command', workforceModule),
    actionDescriptor('demo.merchandise.apply-command', merchandiseModule),
    actionDescriptor('demo.sales-insights.apply-command', 'demo.sales-insights'),
    actionDescriptor('finance.billing.apply-command', billingModule),
    actionDescriptor('property.portfolio.apply-command', portfolioModule),
  ];
  const leasing = actionDescriptor('property.leasing.apply-command', 'property.leasing');
  const rows = reviewedHumanActionAddonRelationships([...operational, leasing, ...descriptors]);
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
  expect(() => reviewedHumanActionAddonRelationships(operational)).toThrow(
    'Reviewed Action missing: property.leasing.apply-command',
  );
});

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
  const rows = demoPermissionRelationships(descriptors);
  const services = [commercePortalPrincipal, privacyConsentPrincipal, crmPartyIntakePrincipal];
  const expected = [
    ...commercePortalRelationships(descriptors),
    ...privacyConsentAuthorityRelationships(descriptors),
    ...crmIntakeRelationships(descriptors),
  ];
  for (const relationship of expected) {
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
