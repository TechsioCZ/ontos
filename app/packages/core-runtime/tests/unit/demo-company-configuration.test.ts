import { Effect, Predicate } from 'effect';
import { expect, it } from 'effect-rstest';

import { configureDemoCompanies } from '../../src/install/demo-company-configuration.ts';
import type {
  DemoCompanyRecord,
  DemoCompanyConfigurationPersistence,
} from '../../src/install/demo-company-configuration.ts';
import {
  additionalDemoCompanies,
  commercialDemoCompany,
  demoCompanyTenantId,
  rentalDemoCompany,
} from '../../src/install/demo-company-profiles.ts';

const commercial: DemoCompanyRecord = {
  ...commercialDemoCompany,
  legalName: 'Siampark DEMO s.r.o.',
  registrationCountry: 'CZ',
  registrationNumber: 'DEMO-SIAMPARK',
  status: 'active',
  tenantId: demoCompanyTenantId,
};
const rental: DemoCompanyRecord = {
  ...rentalDemoCompany,
  registrationCountry: 'CZ',
  registrationNumber: 'DEMO-SIAMPARK-RENTAL',
  status: 'active',
  tenantId: demoCompanyTenantId,
};
const fixture = (initial: readonly DemoCompanyRecord[]) => {
  const rows = [...initial];
  const calls: string[] = [];
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
  return { calls, modules, persistence, rows };
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
    expect(state.calls).toEqual(['load', 'rename-rental', 'modules']);
    const second = yield* configureDemoCompanies(demoCompanyTenantId, state.persistence);
    expect(state.rows).toEqual([canonicalCommercial, rental, ...additionalRows]);
    expect(state.calls).toEqual(['load', 'rename-rental', 'modules', 'load', 'modules']);
    expect(first.previousCompanyCount).toBe(5);
    expect(second.previousCompanyCount).toBe(5);
    expect(second.companies).toEqual(first.companies);
    expect(state.modules.get('legal.agreements')).toBe('disabled');
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
        'AKROS (demo)',
      ]);
      expect(state.calls).toEqual([
        'load',
        'rename',
        'create',
        'create:DEMO-HANAK-CRM',
        'create:DEMO-KAVARNA-ESHOP',
        'create:DEMO-AKROS',
        'modules',
        'load',
        'modules',
      ]);
      expect(state.modules.get('legal.agreements')).toBe('disabled');
      expect(state.modules.get('property.portfolio')).toBe('active');
      expect(second.companies).toEqual(first.companies);
    }),
);
