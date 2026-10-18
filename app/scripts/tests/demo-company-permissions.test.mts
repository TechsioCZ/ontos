import { toLegalEntityAccessObjectId, toModuleAccessObjectId } from '@app/core-runtime';
import { commercialDemoCompany, demoCompanyTenantId, rentalDemoCompany } from '@app/core-runtime/demo-company-profiles';
import { expect, it } from 'effect-rstest';
import { Effect, Predicate } from 'effect';
import { HttpClient, HttpClientResponse } from 'effect/unstable/http';

import { demoLegalEntityId, demoTenantId, rentalDemoLegalEntityId } from '../demo/fixture-ids.mts';
import { demoHumanAccounts, demoPermissionRelationships } from '../demo/permissions.mts';
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
  expect(hasModule(administrator.principalId, demoLegalEntityId, 'siampark.property')).toBe(false);
  expect(hasModule(administrator.principalId, rentalDemoLegalEntityId, 'demo.merchandise')).toBe(false);
  expect(hasModule(administrator.principalId, rentalDemoLegalEntityId, 'siampark.property')).toBe(true);
  for (const legalEntityId of [demoLegalEntityId, rentalDemoLegalEntityId]) {
    expect(hasModule(administrator.principalId, legalEntityId, 'siampark.agreements')).toBe(true);
  }
  expect(hasModule(salesRep.principalId, rentalDemoLegalEntityId, 'demo.workforce')).toBe(true);
  expect(hasModule(accountant.principalId, rentalDemoLegalEntityId, 'siampark.billing-finance')).toBe(true);
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
  expect(identityAdministrators).toEqual([administrator.principalId]);
  expect(new Set(relationships.map((row) => JSON.stringify(row))).size).toBe(relationships.length);
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
