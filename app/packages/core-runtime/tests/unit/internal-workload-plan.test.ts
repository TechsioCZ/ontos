import { describe, expect, it } from 'effect-rstest';

import { internalWorkloadPrincipalId } from '../../src/auth/module-credentials.ts';
import {
  companyBindingIdsOf,
  internalWorkloadDisplayName,
  planTenantInternalWorkloads,
  workloadBindingIdsOf,
} from '../../src/install/internal-workload-plan.ts';
import type {
  InternalWorkloadDeclaration,
  PlatformRegistration,
  TenantWorkloadState,
} from '../../src/install/internal-workload-plan.ts';

const TENANT = '70000000-0000-4000-8000-000000000001';
const OTHER_TENANT = '70000000-0000-4000-8000-000000000002';
const COMPANY_A = '70000000-0000-4000-8000-0000000000a1';
const COMPANY_B = '70000000-0000-4000-8000-0000000000b1';
const WORKLOAD = 'demo.crm.party-intake';
const LABEL = 'CRM · zakládání klientů';
const INTAKE: InternalWorkloadDeclaration = {
  appId: 'crm',
  label: LABEL,
  moduleKey: 'demo.crm',
  workloadKey: WORKLOAD,
};
const COMPANY_NAMES = new Map([
  [COMPANY_A, 'Obchodní firma'],
  [COMPANY_B, 'Nájempark'],
]);

const stateOf = (overrides: Partial<TenantWorkloadState> = {}): TenantWorkloadState => ({
  activeCompanies: new Set([COMPANY_A, COMPANY_B]),
  activeModuleKeys: new Set(['demo.crm']),
  companyNames: COMPANY_NAMES,
  registrations: [],
  tenantId: TENANT,
  ...overrides,
});

/** A registration the platform made and that is whole: active principal, binding and company binding. */
const whole = (legalEntityId: string, tenantId = TENANT): PlatformRegistration => {
  const principalId = internalWorkloadPrincipalId({ legalEntityId, tenantId, workloadKey: WORKLOAD });
  const binding = workloadBindingIdsOf(principalId, 0);
  return {
    activeCompanyBindingId: companyBindingIdsOf(binding.bindingId, legalEntityId, 0).companyBindingId,
    activeWorkloadBindingId: binding.bindingId,
    companyBindingCount: 1,
    displayName: `${LABEL} · ${COMPANY_NAMES.get(legalEntityId) ?? ''}`,
    extraCompanyBindingIds: [],
    legalEntityId,
    principalId,
    principalStatus: 'active',
    workloadBindingCount: 1,
    workloadKey: WORKLOAD,
  };
};

const kinds = (plan: ReturnType<typeof planTenantInternalWorkloads>) => plan.steps.map(({ kind }) => kind);

describe('planTenantInternalWorkloads', () => {
  it('registers an installed module workload once per active company: principal, binding, company binding', () => {
    const plan = planTenantInternalWorkloads(stateOf(), [INTAKE]);
    expect(plan.registered).toBe(2);
    expect(kinds(plan)).toEqual([
      'create-principal',
      'bind-workload',
      'bind-company',
      'create-principal',
      'bind-workload',
      'bind-company',
    ]);
    const principals = plan.steps.flatMap((step) => (step.kind === 'create-principal' ? [step] : []));
    expect(principals.map(({ legalEntityId }) => legalEntityId)).toEqual([COMPANY_A, COMPANY_B]);
    expect(principals.map(({ principalId }) => principalId)).toEqual([
      internalWorkloadPrincipalId({ legalEntityId: COMPANY_A, tenantId: TENANT, workloadKey: WORKLOAD }),
      internalWorkloadPrincipalId({ legalEntityId: COMPANY_B, tenantId: TENANT, workloadKey: WORKLOAD }),
    ]);
    // Each company binding names exactly its own company and its own principal's binding.
    const bindings = plan.steps.flatMap((step) => (step.kind === 'bind-workload' ? [step] : []));
    const companies = plan.steps.flatMap((step) => (step.kind === 'bind-company' ? [step] : []));
    expect(companies.map(({ legalEntityId, workloadBindingId }) => [legalEntityId, workloadBindingId])).toEqual(
      bindings.map(({ bindingId }, index) => [principals[index]?.legalEntityId, bindingId]),
    );
  });

  it('changes nothing when every wanted registration is whole', () => {
    const plan = planTenantInternalWorkloads(stateOf({ registrations: [whole(COMPANY_A), whole(COMPANY_B)] }), [
      INTAKE,
    ]);
    expect(plan).toEqual({
      corrected: 0,
      healed: 0,
      healedPrincipalIds: [],
      registered: 0,
      renamed: 0,
      retired: 0,
      steps: [],
      unchanged: 2,
      units: [],
    });
  });

  it('registers nothing where the module is not installed, and retires what it made when the module is uninstalled', () => {
    expect(planTenantInternalWorkloads(stateOf({ activeModuleKeys: new Set() }), [INTAKE]).steps).toEqual([]);
    const uninstalled = planTenantInternalWorkloads(
      stateOf({ activeModuleKeys: new Set(), registrations: [whole(COMPANY_A), whole(COMPANY_B)] }),
      [INTAKE],
    );
    expect(uninstalled.retired).toBe(2);
    expect(kinds(uninstalled)).toEqual([
      'revoke-company',
      'revoke-workload',
      'disable-principal',
      'revoke-company',
      'revoke-workload',
      'disable-principal',
    ]);
  });

  it('retires the registrations of a workload the catalogue no longer declares', () => {
    const plan = planTenantInternalWorkloads(stateOf({ registrations: [whole(COMPANY_A)] }), []);
    expect(plan.retired).toBe(1);
    expect(kinds(plan)).toEqual(['revoke-company', 'revoke-workload', 'disable-principal']);
  });

  it('registers a company added later and retires the registration of a company no longer active', () => {
    const added = planTenantInternalWorkloads(stateOf({ registrations: [whole(COMPANY_A)] }), [INTAKE]);
    expect(added).toMatchObject({ registered: 1, retired: 0, unchanged: 1 });
    expect(added.steps.find((step) => step.kind === 'create-principal')).toMatchObject({ legalEntityId: COMPANY_B });
    const deactivated = planTenantInternalWorkloads(
      stateOf({ activeCompanies: new Set([COMPANY_A]), registrations: [whole(COMPANY_A), whole(COMPANY_B)] }),
      [INTAKE],
    );
    expect(deactivated).toMatchObject({ registered: 0, retired: 1, unchanged: 1 });
    expect(deactivated.steps).toContainEqual({ kind: 'disable-principal', principalId: whole(COMPANY_B).principalId });
  });

  it('takes a retired company back with the same principal and a fresh binding', () => {
    const retired: PlatformRegistration = {
      ...whole(COMPANY_B),
      activeCompanyBindingId: null,
      activeWorkloadBindingId: null,
      principalStatus: 'disabled',
    };
    const plan = planTenantInternalWorkloads(stateOf({ registrations: [whole(COMPANY_A), retired] }), [INTAKE]);
    expect(kinds(plan)).toEqual(['reactivate-principal', 'bind-workload', 'bind-company']);
    const binding = plan.steps.find((step) => step.kind === 'bind-workload');
    expect(binding).toMatchObject({ bindingId: workloadBindingIdsOf(retired.principalId, 1).bindingId });
  });

  it('heals a registration whose principal something else disabled or archived: the platform owns it', () => {
    const disabled: PlatformRegistration = { ...whole(COMPANY_A), principalStatus: 'disabled' };
    const archived: PlatformRegistration = { ...whole(COMPANY_B), principalStatus: 'archived' };
    const plan = planTenantInternalWorkloads(stateOf({ registrations: [disabled, archived] }), [INTAKE]);
    expect(plan.healed).toBe(2);
    expect(plan.healedPrincipalIds).toEqual([disabled.principalId, archived.principalId]);
    expect(plan.steps).toEqual([
      { kind: 'reactivate-principal', principalId: disabled.principalId },
      { kind: 'reactivate-principal', principalId: archived.principalId },
    ]);
  });

  it('never mixes two tenants: the same company and workload give each tenant its own principal', () => {
    const one = planTenantInternalWorkloads(stateOf({ activeCompanies: new Set([COMPANY_A]) }), [INTAKE]);
    const other = planTenantInternalWorkloads(
      stateOf({ activeCompanies: new Set([COMPANY_A]), tenantId: OTHER_TENANT }),
      [INTAKE],
    );
    const principalOf = (plan: typeof one) =>
      plan.steps.find((step) => step.kind === 'create-principal')?.principalId ?? '';
    expect(principalOf(one)).not.toBe(principalOf(other));
    // Every id the plan writes is derived from its own tenant, so no step of one tenant names another's rows.
    const idsOf = (plan: typeof one) => plan.steps.map((step) => JSON.stringify(step));
    expect(idsOf(one).some((step) => idsOf(other).includes(step))).toBe(false);
  });

  it('names each registration for a person: the workload label and the company, never an identifier', () => {
    const plan = planTenantInternalWorkloads(stateOf(), [INTAKE]);
    const created = plan.steps.flatMap((step) => (step.kind === 'create-principal' ? [step.displayName] : []));
    expect(created).toEqual(['CRM · zakládání klientů · Obchodní firma', 'CRM · zakládání klientů · Nájempark']);
    expect(internalWorkloadDisplayName(LABEL, 'Obchodní firma')).toBe(created[0]);
    for (const name of created) {
      expect(name).not.toMatch(/[\da-f]{8}-[\da-f]{4}|demo\.crm/u);
    }
  });

  it('follows a renamed company or label with a rename alone, and renames nothing it holds or retires', () => {
    const renamedCompany = planTenantInternalWorkloads(
      stateOf({
        companyNames: new Map([...COMPANY_NAMES, [COMPANY_A, 'Obchodní firma, s.r.o.']]),
        registrations: [whole(COMPANY_A), whole(COMPANY_B)],
      }),
      [INTAKE],
    );
    expect(renamedCompany).toMatchObject({ registered: 0, renamed: 1, retired: 0, unchanged: 1 });
    expect(renamedCompany.steps).toEqual([
      {
        displayName: 'CRM · zakládání klientů · Obchodní firma, s.r.o.',
        kind: 'rename-principal',
        principalId: whole(COMPANY_A).principalId,
      },
    ]);
    const setAside: PlatformRegistration = {
      ...whole(COMPANY_A),
      displayName: 'Renamed by an administrator',
      principalStatus: 'archived',
    };
    // Healed and given back its name in one unit.
    expect(
      planTenantInternalWorkloads(stateOf({ registrations: [setAside, whole(COMPANY_B)] }), [INTAKE]).steps,
    ).toEqual([
      { kind: 'reactivate-principal', principalId: setAside.principalId },
      {
        displayName: 'CRM · zakládání klientů · Obchodní firma',
        kind: 'rename-principal',
        principalId: setAside.principalId,
      },
    ]);
    const retiring = planTenantInternalWorkloads(
      stateOf({ activeModuleKeys: new Set(), registrations: [{ ...whole(COMPANY_A), displayName: 'old' }] }),
      [INTAKE],
    );
    expect(retiring.steps.some(({ kind }) => kind === 'rename-principal')).toBe(false);
  });

  it('revokes a company binding a registration holds beyond its own company (one binding, one company)', () => {
    const extra = 'aaaaaaaa-0000-4000-8000-000000000001';
    const plan = planTenantInternalWorkloads(
      stateOf({ registrations: [{ ...whole(COMPANY_A), extraCompanyBindingIds: [extra] }, whole(COMPANY_B)] }),
      [INTAKE],
    );
    expect(plan).toMatchObject({ corrected: 1, registered: 0, unchanged: 1 });
    expect(plan.steps).toEqual([{ companyBindingId: extra, kind: 'revoke-company' }]);
  });

  it('groups the steps by registration, wanted ones first, so one failing registration stops no other', () => {
    const plan = planTenantInternalWorkloads(
      stateOf({ activeCompanies: new Set([COMPANY_B]), registrations: [whole(COMPANY_A)] }),
      [INTAKE],
    );
    expect(plan.units.map(({ legalEntityId, steps }) => [legalEntityId, steps.map(({ kind }) => kind)])).toEqual([
      [COMPANY_B, ['create-principal', 'bind-workload', 'bind-company']],
      [COMPANY_A, ['revoke-company', 'revoke-workload', 'disable-principal']],
    ]);
    expect(plan.steps).toEqual(plan.units.flatMap(({ steps }) => steps));
  });
});
