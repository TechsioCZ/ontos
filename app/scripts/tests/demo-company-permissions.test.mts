import {
  toContextPermissionAccessObjectId,
  toLegalEntityAccessObjectId,
  toModuleAccessObjectId,
} from '@app/core-runtime';
import { toSpiceDbActionObjectId } from '@app/core-runtime/actions/runtime-wiring';
import { commercialDemoCompany, demoCompanyTenantId, rentalDemoCompany } from '@app/core-runtime/demo-company-profiles';
import { expect, it } from 'effect-rstest';
import { Effect, Predicate } from 'effect';
import { HttpClient, HttpClientResponse } from 'effect/unstable/http';

import {
  crmDemoLegalEntityId,
  demoLegalEntityId,
  demoTenantId,
  eshopDemoLegalEntityId,
  rentalDemoLegalEntityId,
} from '../demo/fixture-ids.mts';
import {
  companyHumanAccounts,
  crmPersonaPrincipalIds,
  demoHumanAccounts,
  demoPermissionRelationships,
  siamparkRentalPersonas,
  storefrontPrincipal,
} from '../demo/permissions.mts';
import { ensureDemoCompanies } from '../demo/reset-permissions.mts';
import {
  commercePortalActionKeys,
  commercePortalPrincipal,
  commercePortalRelationships,
  commercePortalVerificationWorkloadGrants,
  privacyConsentAuthorityRelationships,
  privacyConsentPrincipal,
} from '../demo/commerce-portal.mts';
import { toIdentityNamespaceAccessObjectId } from '../../packages/core-runtime/src/permissions/context-access.ts';

const merchandiseModule = 'demo.merchandise';
const portfolioModule = 'property.portfolio';
const billingModule = 'finance.billing';

const companySuffix = '/demo-companies';
const shellOrigin = 'http://localhost:3020';
const relationships = demoPermissionRelationships([
  { actionKey: 'core.identity.configure-demo-companies', provisioning: 'explicit' },
]);
const [administrator, salesRep, accountant, warehouse] = demoHumanAccounts;

it('retains legacy fixture IDs and agrees with the Core company configuration', () => {
  expect(demoTenantId).toBe(demoCompanyTenantId);
  expect(demoLegalEntityId).toBe(commercialDemoCompany.legalEntityId);
  expect(rentalDemoLegalEntityId).toBe(rentalDemoCompany.legalEntityId);
});
const hasModule = (principalId: string, legalEntityId: string, moduleId: string) =>
  relationships.some(
    (row) =>
      row.resourceType === 'module_access' &&
      row.resourceId === toModuleAccessObjectId(demoTenantId, legalEntityId, moduleId) &&
      row.relation === 'accessor' &&
      row.subjectId === principalId,
  );

it('separates commercial stock access from rental property access while sharing agreements', () => {
  expect(hasModule(administrator.principalId, demoLegalEntityId, merchandiseModule)).toBe(true);
  expect(hasModule(administrator.principalId, demoLegalEntityId, portfolioModule)).toBe(false);
  expect(hasModule(administrator.principalId, rentalDemoLegalEntityId, merchandiseModule)).toBe(false);
  expect(hasModule(administrator.principalId, rentalDemoLegalEntityId, portfolioModule)).toBe(true);
  for (const legalEntityId of [demoLegalEntityId, rentalDemoLegalEntityId]) {
    expect(hasModule(administrator.principalId, legalEntityId, 'legal.agreements')).toBe(true);
  }
  expect(hasModule(salesRep.principalId, rentalDemoLegalEntityId, 'demo.workforce')).toBe(true);
  expect(hasModule(accountant.principalId, rentalDemoLegalEntityId, billingModule)).toBe(true);
});

it('keeps the warehouse account out of the rental company and limits identity administration', () => {
  const rentalObject = toLegalEntityAccessObjectId(demoTenantId, rentalDemoLegalEntityId);
  expect(
    relationships.some(
      (row) =>
        row.resourceType === 'legal_entity' &&
        row.resourceId === rentalObject &&
        row.relation === 'member' &&
        row.subjectId === warehouse.principalId,
    ),
  ).toBe(false);
  const identityAdministrators = relationships
    .filter((row) => row.resourceType === 'tenant' && row.relation === 'identity_admin')
    .map((row) => row.subjectId);
  // The AKROS administrator owns its real agent entities and has had this declared role since 5e1deb67f.
  // Storefront and Commerce/Privacy service principals must never acquire tenant identity administration.
  const akrosAdministrator = companyHumanAccounts.find((account) => account.role === 'akrosAdmin');
  expect(akrosAdministrator).toBeDefined();
  expect(identityAdministrators).toEqual([
    administrator.principalId,
    crmPersonaPrincipalIds.spravce,
    akrosAdministrator?.principalId,
  ]);
  expect(new Set(relationships.map((row) => JSON.stringify(row))).size).toBe(relationships.length);
});

const memberOf = (principalId: string) =>
  relationships
    .filter((row) => row.resourceType === 'legal_entity' && row.relation === 'member' && row.subjectId === principalId)
    .map((row) => row.resourceId);
const hasCrmPermission = (principalId: string, permission: string) =>
  relationships.some(
    (row) =>
      row.resourceType === 'context_permission' &&
      row.relation === 'grantee' &&
      row.subjectId === principalId &&
      row.resourceId ===
        toContextPermissionAccessObjectId(demoTenantId, crmDemoLegalEntityId, { moduleId: 'demo.crm', permission }),
  );

it('keeps CRM and e-shop personas inside their own company with role-specific CRM visibility', () => {
  for (const account of companyHumanAccounts) {
    expect(memberOf(account.principalId)).toEqual([toLegalEntityAccessObjectId(demoTenantId, account.legalEntityId)]);
  }
  expect(memberOf(storefrontPrincipal.principalId)).toEqual([
    toLegalEntityAccessObjectId(demoTenantId, eshopDemoLegalEntityId),
  ]);
  expect(hasModule(crmPersonaPrincipalIds.repA, crmDemoLegalEntityId, 'demo.crm')).toBe(true);
  expect(hasModule(crmPersonaPrincipalIds.repA, crmDemoLegalEntityId, 'party.registry')).toBe(false);
  expect(hasModule(storefrontPrincipal.principalId, eshopDemoLegalEntityId, merchandiseModule)).toBe(true);
  expect(hasModule(storefrontPrincipal.principalId, eshopDemoLegalEntityId, 'party.registry')).toBe(false);
  expect(hasModule(administrator.principalId, crmDemoLegalEntityId, 'demo.crm')).toBe(false);
  expect(hasCrmPermission(crmPersonaPrincipalIds.manager, 'demo.crm.read_all')).toBe(true);
  expect(hasCrmPermission(crmPersonaPrincipalIds.repA, 'demo.crm.read_all')).toBe(false);
  expect(hasCrmPermission(crmPersonaPrincipalIds.repB, 'demo.crm.read_assigned')).toBe(true);
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

it('gives the Siampark accounts their 0021 roles and limits the external agent to operational agendas', () => {
  const opsPermission = (principalId: string, permission: string) =>
    relationships.some(
      (row) =>
        row.resourceType === 'context_permission' &&
        row.relation === 'grantee' &&
        row.subjectId === principalId &&
        row.resourceId ===
          toContextPermissionAccessObjectId(demoTenantId, rentalDemoLegalEntityId, {
            moduleId: 'facility.operations',
            permission,
          }),
    );
  const [management, , finance, external] = siamparkRentalPersonas;
  expect(hasModule(management.principalId, rentalDemoLegalEntityId, portfolioModule)).toBe(true);
  expect(opsPermission(management.principalId, 'facility.operations.write_all')).toBe(true);
  expect(hasModule(finance.principalId, rentalDemoLegalEntityId, billingModule)).toBe(true);
  expect(hasModule(external.principalId, rentalDemoLegalEntityId, 'facility.operations')).toBe(true);
  expect(hasModule(external.principalId, rentalDemoLegalEntityId, billingModule)).toBe(false);
  expect(opsPermission(external.principalId, 'facility.operations.read_operational')).toBe(true);
  expect(opsPermission(external.principalId, 'facility.operations.read_all')).toBe(false);
  expect(opsPermission(external.principalId, 'facility.operations.write_operational')).toBe(false);
  expect(opsPermission(external.principalId, 'facility.operations.write_all')).toBe(false);
});

it('provisions only the Commerce portal namespace and its three Core binding Actions without identity administration', () => {
  const coreActions = [
    'core.identity.activate-principal-binding',
    'core.identity.change-principal-binding-status',
    'core.identity.reserve-principal-binding',
  ];
  const rows = commercePortalRelationships(coreActions.map((actionKey) => ({ actionKey, provisioning: 'explicit' })));
  const namespace = toIdentityNamespaceAccessObjectId(demoTenantId, 'ontos.commerce.portal.better-auth.v1');
  expect(rows.filter((row) => row.resourceType === 'identity_namespace')).toEqual([
    {
      relation: 'tenant',
      resourceId: namespace,
      resourceType: 'identity_namespace',
      subjectId: demoTenantId,
      subjectType: 'tenant',
    },
    {
      relation: 'provisioner',
      resourceId: namespace,
      resourceType: 'identity_namespace',
      subjectId: commercePortalPrincipal.principalId,
      subjectType: 'principal',
    },
  ]);
  for (const actionKey of coreActions) {
    expect(commercePortalActionKeys).toContain(actionKey);
  }
  expect(rows.filter((row) => row.resourceType === 'action' && row.relation === 'executor')).toHaveLength(3);
  expect(rows.some((row) => row.relation === 'identity_admin')).toBe(false);
});

it('grants the Commerce enrollment business permissions without broadening its Party Actions or company scope', () => {
  expect(commercePortalActionKeys.filter((actionKey) => actionKey.startsWith('party.registry.'))).toEqual([
    'party.registry.create-party',
    'party.registry.counterparty-customer-onboard',
    'party.registry.add-contact-point',
    'party.registry.update-party',
    'party.registry.update-contact-point',
  ]);
  const unrelatedPartyActions = [
    'party.registry.archive-party',
    'party.registry.resolve-duplicate-candidate-create',
    'party.registry.create-party-relationship',
  ];
  const rows = commercePortalRelationships(
    [...commercePortalActionKeys, ...unrelatedPartyActions].map((actionKey) => ({
      actionKey,
      provisioning: 'explicit',
    })),
  );
  const { principalId } = commercePortalPrincipal;
  expect(rows.filter((row) => row.resourceType === 'tenant').map((row) => row.relation)).toEqual([
    'member',
    'party_identity_reader',
    'party_identity_manager',
  ]);
  const legal = toLegalEntityAccessObjectId(demoTenantId, commercePortalPrincipal.legalEntityId);
  expect(rows.filter((row) => row.resourceType === 'legal_entity')).toEqual([
    {
      relation: 'tenant',
      resourceId: legal,
      resourceType: 'legal_entity',
      subjectId: demoTenantId,
      subjectType: 'tenant',
    },
    {
      relation: 'member',
      resourceId: legal,
      resourceType: 'legal_entity',
      subjectId: principalId,
      subjectType: 'principal',
    },
    {
      relation: 'counterparty_reader',
      resourceId: legal,
      resourceType: 'legal_entity',
      subjectId: principalId,
      subjectType: 'principal',
    },
    {
      relation: 'counterparty_manager',
      resourceId: legal,
      resourceType: 'legal_entity',
      subjectId: principalId,
      subjectType: 'principal',
    },
  ]);
  expect(rows.filter((row) => row.relation === 'executor').map((row) => row.resourceId)).toEqual(
    commercePortalActionKeys.map(toSpiceDbActionObjectId),
  );
  expect(rows.some((row) => row.relation === 'identity_admin' || row.relation === 'party_identity_reviewer')).toBe(
    false,
  );
});

it('grants the Privacy authority reader exactly two Commerce facts without customer, Party or consent writes', () => {
  const actions = [
    ...commercePortalActionKeys,
    'privacy.core.create-processing-purpose',
    'privacy.core.record-consent-decision',
    'commerce.customer-context.apply-command',
  ].map((actionKey) => ({ actionKey, provisioning: 'explicit' as const }));
  const rows = privacyConsentAuthorityRelationships(actions);
  expect(rows.filter((row) => row.relation === 'executor')).toHaveLength(0);
  expect(rows.some((row) => row.relation === 'identity_admin')).toBe(false);
  expect(rows.filter((row) => row.resourceType === 'context_permission' && row.relation === 'grantee')).toEqual(
    ['customer.consent.resolve_authority', 'customer.notice.resolve_authority'].map((permission) => ({
      relation: 'grantee',
      resourceId: toContextPermissionAccessObjectId(demoTenantId, privacyConsentPrincipal.legalEntityId, {
        moduleId: 'commerce.customer-context',
        permission,
      }),
      resourceType: 'context_permission',
      subjectId: privacyConsentPrincipal.principalId,
      subjectType: 'principal',
    })),
  );
  expect(
    rows
      .filter((row) => row.resourceType === 'module_access' && row.relation === 'accessor')
      .map((row) => row.resourceId),
  ).toEqual(
    ['core.shell', 'commerce.customer-context'].map((moduleId) =>
      toModuleAccessObjectId(demoTenantId, privacyConsentPrincipal.legalEntityId, moduleId),
    ),
  );
  expect(privacyConsentPrincipal.principalId).not.toBe(commercePortalPrincipal.principalId);
});

it('grants Commerce only native customer consent setup/provision/self-service Actions, never purpose or direct decision writes', () => {
  const allowed = [
    'privacy.core.create-privacy-subject',
    'privacy.core.create-notice-version',
    'privacy.core.record-notice-provision',
    'privacy.core.consent-self-service',
  ];
  for (const actionKey of allowed) {
    expect(commercePortalActionKeys).toContain(actionKey);
  }
  expect(commercePortalActionKeys).not.toContain('privacy.core.create-processing-purpose');
  expect(commercePortalActionKeys).not.toContain('privacy.core.record-consent-decision');
  expect(
    demoPermissionRelationships(allowed.map((actionKey) => ({ actionKey, provisioning: 'explicit' })))
      .filter(
        (row) =>
          row.subjectId === storefrontPrincipal.principalId &&
          row.resourceType === 'action' &&
          row.relation === 'executor',
      )
      .some((row) => allowed.some((actionKey) => row.resourceId === toSpiceDbActionObjectId(actionKey))),
  ).toBe(false);
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
