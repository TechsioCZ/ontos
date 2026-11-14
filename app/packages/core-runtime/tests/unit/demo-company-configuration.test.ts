import { Effect, Predicate } from 'effect';
import { expect, it } from 'effect-rstest';

import { configureDemoCompanies } from '../../src/install/demo-company-configuration.ts';
import type {
  DemoCompanyRecord,
  DemoCompanyConfigurationPersistence,
} from '../../src/install/demo-company-configuration.ts';
import {
  additionalDemoCompanies,
  akrosDemoCompany,
  commercialDemoCompany,
  demoCompanyTenantId,
  rentalDemoCompany,
} from '../../src/install/demo-company-profiles.ts';

const commercial: DemoCompanyRecord = {
  ...commercialDemoCompany,
  legalName: 'Siampark DEMO s.r.o.',
  registrationCountry: 'CZ',
  registrationNumber: 'DEMO-NAJEMPARK',
  status: 'active',
  tenantId: demoCompanyTenantId,
};
const rental: DemoCompanyRecord = {
  ...rentalDemoCompany,
  registrationCountry: 'CZ',
  registrationNumber: 'DEMO-NAJEMPARK-RENTAL',
  status: 'active',
  tenantId: demoCompanyTenantId,
};
const fixture = (initial: readonly DemoCompanyRecord[]) => {
  const rows = [...initial];
  const calls: string[] = [];
  const scoped: string[][] = [];
  const modules = new Map([['legal.agreements', 'disabled']]);
  const persistence: DemoCompanyConfigurationPersistence = {
    createCompany: ({ legalEntityId, legalName, registrationNumber }) =>
      Effect.sync(() => {
        calls.push(`create:${registrationNumber}`);
        rows.push({
          legalEntityId,
          legalName,
          registrationCountry: 'CZ',
          registrationNumber,
          status: 'active',
          tenantId: demoCompanyTenantId,
        });
      }),
    createRental: Effect.sync(() => {
      calls.push('create');
      rows.push(rental);
    }),
    ensureCompanyScopes: (legalEntityIds: readonly string[]) =>
      Effect.sync(() => {
        calls.push('scopes');
        scoped.push([...legalEntityIds]);
      }),
    ensureModules: Effect.sync(() => {
      calls.push('modules');
      for (const moduleId of ['property.portfolio', 'property.leasing', 'legal.agreements']) {
        if (!modules.has(moduleId)) {
          modules.set(moduleId, 'active');
        }
      }
    }),
    load: Effect.sync(() => {
      calls.push('load');
      return [...rows];
    }),
    pseudonymizeScrewSeller: Effect.sync(() => {
      calls.push('pseudonymize-screw-seller');
      for (const [index, row] of rows.entries()) {
        if (row.legalEntityId === akrosDemoCompany.legalEntityId) {
          rows[index] = { ...row, legalName: akrosDemoCompany.legalName, registrationNumber: 'DEMO-SROUBARNA' };
        }
      }
    }),
    renameCommercial: Effect.sync(() => {
      calls.push('rename');
      const index = rows.findIndex((row) => row.legalEntityId === commercialDemoCompany.legalEntityId);
      rows.splice(index, 1, { ...commercial, legalName: commercialDemoCompany.legalName });
    }),
    renameRental: Effect.sync(() => {
      calls.push('rename-rental');
      for (const [index, row] of rows.entries()) {
        if (row.legalEntityId === rentalDemoCompany.legalEntityId) {
          rows[index] = { ...row, legalName: rentalDemoCompany.legalName };
        }
      }
    }),
  };
  return { calls, modules, persistence, rows, scoped };
};

it.effect('rejects other tenants before loading or mutating company state', () =>
  Effect.gen(function* rejectForeignTenant() {
    const state = fixture([commercial]);
    const error = yield* configureDemoCompanies('11111111-1111-4111-8111-111111111111', state.persistence).pipe(
      Effect.flip,
    );
    expect(Predicate.isTagged(error, 'IdentityTargetInvalidError')).toBe(true);
    expect(state.calls).toEqual([]);
  }),
);

it.effect('refuses conflicting registrations, owners and user-renamed companies before any write', () =>
  Effect.forEach(
    [
      [],
      [{ ...commercial, tenantId: '11111111-1111-4111-8111-111111111111' }],
      [{ ...commercial, registrationNumber: 'A-REAL-COMPANY' }],
      [{ ...commercial, legalName: 'Customer custom company' }],
      [commercial, { ...rental, legalName: 'Customer custom rental company' }],
      [commercial, { ...rental, legalName: 'Nájempark s.r.o.' }],
      [commercial, { ...rental, legalName: 'Siampark ' }],
      [commercial, { ...rental, legalName: 'siampark' }],
      [commercial, { ...rental, tenantId: '11111111-1111-4111-8111-111111111111' }],
      [commercial, { ...rental, registrationNumber: 'OTHER-IDENTITY' }],
      [commercial, { ...rental, legalEntityId: '11111111-1111-4111-8111-111111111111' }],
      [commercial, { ...rental, legalName: 'Siampark', tenantId: '11111111-1111-4111-8111-111111111111' }],
      [commercial, { ...rental, legalName: 'Siampark', registrationNumber: 'OTHER-IDENTITY' }],
      [commercial, { ...rental, legalName: 'Siampark', registrationCountry: 'SK' }],
      [commercial, { ...rental, legalName: 'Siampark', status: 'inactive' }],
    ],
    (rows) =>
      Effect.gen(function* conflictBeforeWrite() {
        const state = fixture(rows);
        const error = yield* configureDemoCompanies(demoCompanyTenantId, state.persistence).pipe(Effect.flip);
        expect(Predicate.isTagged(error, 'IdentityLifecycleConflictError')).toBe(true);
        expect(state.calls).toEqual(['load']);
      }),
    { concurrency: 1 },
  ),
);

it.effect('renames the exact legacy rental once at the same UUID and leaves canonical names unchanged on rerun', () =>
  Effect.gen(function* idempotentRentalRename() {
    const additionalRows = additionalDemoCompanies.map((company) => ({
      ...company,
      registrationCountry: 'CZ',
      status: 'active',
      tenantId: demoCompanyTenantId,
    }));
    const canonicalCommercial = { ...commercial, legalName: commercialDemoCompany.legalName };
    const state = fixture([canonicalCommercial, { ...rental, legalName: 'Siampark' }, ...additionalRows]);
    const first = yield* configureDemoCompanies(demoCompanyTenantId, state.persistence);
    expect(rentalDemoCompany).toEqual({
      legalEntityId: '71000000-0000-4000-8000-000000000021',
      legalName: 'Nájempark',
    });
    expect(state.rows).toEqual([canonicalCommercial, rental, ...additionalRows]);
    expect(state.calls).toEqual(['load', 'rename-rental', 'scopes', 'modules']);
    const second = yield* configureDemoCompanies(demoCompanyTenantId, state.persistence);
    expect(state.rows).toEqual([canonicalCommercial, rental, ...additionalRows]);
    expect(state.calls).toEqual(['load', 'rename-rental', 'scopes', 'modules', 'load', 'scopes', 'modules']);
    expect(first.previousCompanyCount).toBe(5);
    expect(second.previousCompanyCount).toBe(5);
    expect(second.companies).toEqual(first.companies);
    expect(state.modules.get('legal.agreements')).toBe('disabled');
  }),
);

it.effect('pseudonymizes only the exact synthetic company once; rejects partial or foreign identities', () =>
  Effect.gen(function* pseudonymizeCompany() {
    const canonicalCommercial = { ...commercial, legalName: commercialDemoCompany.legalName };
    const legacy = {
      ...akrosDemoCompany,
      legalName: 'AKROS (demo)',
      registrationCountry: 'CZ',
      registrationNumber: 'DEMO-AKROS',
      status: 'active',
      tenantId: demoCompanyTenantId,
    };
    for (const changed of [
      { legalName: 'AKROS' },
      { registrationNumber: 'OTHER' },
      { registrationCountry: 'SK' },
      { status: 'disabled' },
      { tenantId: '11111111-1111-4111-8111-111111111111' },
    ]) {
      const invalidState = fixture([canonicalCommercial, { ...legacy, ...changed }]);
      const error = yield* configureDemoCompanies(demoCompanyTenantId, invalidState.persistence).pipe(Effect.flip);
      expect(Predicate.isTagged(error, 'IdentityLifecycleConflictError')).toBe(true);
      expect(invalidState.calls).toEqual(['load']);
    }
    const state = fixture([
      canonicalCommercial,
      rental,
      ...additionalDemoCompanies.slice(0, 2).map((company) => ({
        ...company,
        registrationCountry: 'CZ',
        status: 'active',
        tenantId: demoCompanyTenantId,
      })),
      legacy,
    ]);
    yield* configureDemoCompanies(demoCompanyTenantId, state.persistence);
    yield* configureDemoCompanies(demoCompanyTenantId, state.persistence);
    expect(state.rows.at(-1)).toEqual({
      ...legacy,
      legalName: akrosDemoCompany.legalName,
      registrationNumber: 'DEMO-SROUBARNA',
    });
    expect(state.calls).toEqual([
      'load',
      'pseudonymize-screw-seller',
      'scopes',
      'modules',
      'load',
      'scopes',
      'modules',
    ]);
  }),
);

it.effect(
  'renames only the commercial name, creates one rental entity and preserves existing module states on repeat',
  () =>
    Effect.gen(function* idempotentCompanyConfiguration() {
      const state = fixture([commercial]);
      const first = yield* configureDemoCompanies(demoCompanyTenantId, state.persistence);
      const second = yield* configureDemoCompanies(demoCompanyTenantId, state.persistence);
      expect(first.previousCompanyCount).toBe(1);
      expect(second.previousCompanyCount).toBe(5);
      expect(state.rows.slice(0, 2)).toEqual([{ ...commercial, legalName: commercialDemoCompany.legalName }, rental]);
      expect(state.rows.map((row) => row.legalName).slice(2)).toEqual([
        'Velkoobchod Hanák s.r.o.',
        'Kavárna Doma s.r.o.',
        'Šroubárna Vysočina s.r.o.',
      ]);
      expect(state.calls).toEqual([
        'load',
        'rename',
        'create',
        'create:DEMO-HANAK-CRM',
        'create:DEMO-KAVARNA-ESHOP',
        'create:DEMO-SROUBARNA',
        'scopes',
        'modules',
        'load',
        'scopes',
        'modules',
      ]);
      expect(state.modules.get('legal.agreements')).toBe('disabled');
      expect(state.modules.get('property.portfolio')).toBe('active');
      expect(second.companies).toEqual(first.companies);
    }),
);

it.effect('gives every company it creates or keeps an access scope, in the same configuration, on every run', () =>
  Effect.gen(function* companyScopesWithCompanies() {
    const state = fixture([commercial]);
    yield* configureDemoCompanies(demoCompanyTenantId, state.persistence);
    const everyCompany = [
      commercialDemoCompany.legalEntityId,
      rentalDemoCompany.legalEntityId,
      ...additionalDemoCompanies.map((company) => company.legalEntityId),
    ].toSorted();
    expect(state.scoped.map((ids) => ids.toSorted())).toEqual([everyCompany]);
    // The scopes follow the companies it created, never precede them.
    expect(state.calls.indexOf('scopes')).toBeGreaterThan(state.calls.lastIndexOf('create:DEMO-SROUBARNA'));
    yield* configureDemoCompanies(demoCompanyTenantId, state.persistence);
    expect(state.scoped).toHaveLength(2);
  }),
);
