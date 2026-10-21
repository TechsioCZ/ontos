import {
  toContextPermissionAccessObjectId,
  toLegalEntityAccessObjectId,
  toModuleAccessObjectId,
} from '@app/core-runtime';
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
  expect(hasModule(administrator.principalId, demoLegalEntityId, 'demo.merchandise')).toBe(true);
  expect(hasModule(administrator.principalId, demoLegalEntityId, 'property.portfolio')).toBe(false);
  expect(hasModule(administrator.principalId, rentalDemoLegalEntityId, 'demo.merchandise')).toBe(false);
  expect(hasModule(administrator.principalId, rentalDemoLegalEntityId, 'property.portfolio')).toBe(true);
  for (const legalEntityId of [demoLegalEntityId, rentalDemoLegalEntityId]) {
    expect(hasModule(administrator.principalId, legalEntityId, 'legal.agreements')).toBe(true);
  }
  expect(hasModule(salesRep.principalId, rentalDemoLegalEntityId, 'demo.workforce')).toBe(true);
  expect(hasModule(accountant.principalId, rentalDemoLegalEntityId, 'finance.billing')).toBe(true);
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
  expect(identityAdministrators).toEqual([administrator.principalId, crmPersonaPrincipalIds.spravce]);
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
  expect(hasModule(storefrontPrincipal.principalId, eshopDemoLegalEntityId, 'demo.merchandise')).toBe(true);
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
  expect(hasModule(management.principalId, rentalDemoLegalEntityId, 'property.portfolio')).toBe(true);
  expect(opsPermission(management.principalId, 'facility.operations.write_all')).toBe(true);
  expect(hasModule(finance.principalId, rentalDemoLegalEntityId, 'finance.billing')).toBe(true);
  expect(hasModule(external.principalId, rentalDemoLegalEntityId, 'facility.operations')).toBe(true);
  expect(hasModule(external.principalId, rentalDemoLegalEntityId, 'finance.billing')).toBe(false);
  expect(opsPermission(external.principalId, 'facility.operations.read_operational')).toBe(true);
  expect(opsPermission(external.principalId, 'facility.operations.read_all')).toBe(false);
  expect(opsPermission(external.principalId, 'facility.operations.write_operational')).toBe(false);
  expect(opsPermission(external.principalId, 'facility.operations.write_all')).toBe(false);
});
