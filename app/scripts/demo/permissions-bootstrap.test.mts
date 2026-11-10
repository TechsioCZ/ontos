import { readFileSync } from 'node:fs';

import { Schema } from 'effect';
import { expect, it } from 'effect-rstest';

import { WorkloadKeySchema } from '../../packages/core-runtime/src/authorization/access-declaration.ts';

import {
  IDENTITY_PROVIDER_WORKLOAD,
  CRM_PARTY_INTAKE_WORKLOAD,
  STOREFRONT_CLIENT_WORKLOAD,
  STOREFRONT_INQUIRY_WORKLOAD,
  STOREFRONT_MERCHANDISE_WORKLOAD,
  agentBotPrincipal,
  akrosStorefrontPrincipal,
  commercePortalPrincipal,
  companyHumanAccounts,
  crmPartyIntakePrincipal,
  demoHumanAccounts,
  demoLegalEntityIds,
  demoShellRoutingRoleKey,
  demoShellRoutingRole,
  demoTenantMemberships,
  demoPrincipalRoleKey,
  kavarnaMarketAuthorityPrincipal,
  marketRetirementPrincipal,
  privacyConsentPrincipal,
  reviewedDemoAssignments,
  reviewedMachinePrincipals,
  reviewedWorkloadBindings,
  siamparkRentalPersonas,
  storefrontPrincipal,
  unmappedServicePrincipals,
} from './permissions.mts';

it('assigns every reviewed persona under one role key that names exactly one reviewed policy', () => {
  const assignments = reviewedDemoAssignments();
  // Two principals may share a role key only when they share its reviewed policy (the CRM representatives).
  const policiesByKey = new Map<string, string>();
  for (const assignment of assignments) {
    const policy = JSON.stringify(assignment.role);
    const existing = policiesByKey.get(assignment.roleKey);
    expect({ roleKey: assignment.roleKey, samePolicy: existing === undefined || existing === policy }).toEqual({
      roleKey: assignment.roleKey,
      samePolicy: true,
    });
    policiesByKey.set(assignment.roleKey, policy);
  }
  // The CRM representatives deliberately share one reviewed profile, so they share its Role key.
  const crmReps = assignments.filter((entry) => entry.roleKey.includes('crm-sales'));
  expect(new Set(crmReps.map((entry) => entry.role.label))).toEqual(new Set(['Obchodník']));
});

it('covers every reviewed person identity, and never assigns a machine a Role', () => {
  const assignments = reviewedDemoAssignments();
  const assigned = new Set(assignments.map((entry) => entry.principalId));
  for (const account of demoHumanAccounts) {
    expect(assigned.has(account.principalId)).toBe(true);
  }
  for (const account of companyHumanAccounts) {
    expect(assigned.has(account.principalId)).toBe(true);
  }
  for (const persona of siamparkRentalPersonas) {
    expect(assigned.has(persona.principalId)).toBe(true);
  }
  // A machine identity is never a Role holder: that would be the retired scoped-role model.
  for (const machine of reviewedMachinePrincipals) {
    expect(assigned.has(machine.principalId)).toBe(false);
  }
});

it('names the reviewed company of every company-scoped assignment, and never a foreign one', () => {
  const known = new Set(demoLegalEntityIds);
  for (const assignment of reviewedDemoAssignments()) {
    if (assignment.legalEntityId !== undefined) {
      expect(known.has(assignment.legalEntityId)).toBe(true);
    }
  }
  const tenantAssignments = reviewedDemoAssignments().filter((entry) => entry.legalEntityId === undefined);
  expect(tenantAssignments.map(({ principalId }) => principalId).toSorted()).toEqual(
    demoTenantMemberships.map(({ principalId }) => principalId).toSorted(),
  );
  for (const assignment of tenantAssignments) {
    expect(assignment.roleKey).toBe(demoShellRoutingRoleKey);
    expect(assignment.role).toBe(demoShellRoutingRole);
  }
});

it('binds only the declared workload keys, and only for principals whose caller runs them', () => {
  const bindings = reviewedWorkloadBindings();
  const keys = new Set(bindings.map((binding) => binding.workloadKey));
  expect(keys).toEqual(
    new Set([
      STOREFRONT_CLIENT_WORKLOAD,
      STOREFRONT_MERCHANDISE_WORKLOAD,
      STOREFRONT_INQUIRY_WORKLOAD,
      IDENTITY_PROVIDER_WORKLOAD,
      CRM_PARTY_INTAKE_WORKLOAD,
    ]),
  );
  // Every key is one a carrier of this release declares, in that carrier module's own namespace.
  const catalog = Schema.decodeUnknownSync(
    Schema.fromJsonString(Schema.Struct({ declaredWorkloadKeys: Schema.Array(WorkloadKeySchema) })),
  )(readFileSync(new URL('../../topology/authorization-catalog.json', import.meta.url), 'utf-8'));
  for (const key of keys) {
    expect(catalog.declaredWorkloadKeys).toContain(key);
  }
  const principals = new Set(bindings.map((binding) => binding.principalId));
  expect(principals).toEqual(
    new Set([
      storefrontPrincipal.principalId,
      akrosStorefrontPrincipal.principalId,
      commercePortalPrincipal.principalId,
      crmPartyIntakePrincipal.principalId,
    ]),
  );
  // The identity provider key belongs to the portal alone; the storefronts are clients only.
  expect(
    bindings.filter((binding) => binding.workloadKey === IDENTITY_PROVIDER_WORKLOAD).map((b) => b.principalId),
  ).toEqual([commercePortalPrincipal.principalId]);
  // Only ŠroubShop's storefront has an inquiry form, so it alone files inquiries into Work Tasks.
  expect(
    bindings.filter((binding) => binding.workloadKey === STOREFRONT_INQUIRY_WORKLOAD).map((b) => b.principalId),
  ).toEqual([akrosStorefrontPrincipal.principalId]);
});

it('binds each storefront to what its BFF calls, registered for its own company as on stage', () => {
  const bindings = reviewedWorkloadBindings();
  const of = (principalId: string) =>
    bindings
      .filter((binding) => binding.principalId === principalId)
      .map(({ legalEntityId, workloadKey }) => ({ legalEntityId, workloadKey }));
  // Merchandise records/media reads and the guest order, the market catalog and portal journey, the inquiry form.
  expect(new Set(of(akrosStorefrontPrincipal.principalId).map(({ workloadKey }) => workloadKey))).toEqual(
    new Set([STOREFRONT_CLIENT_WORKLOAD, STOREFRONT_MERCHANDISE_WORKLOAD, STOREFRONT_INQUIRY_WORKLOAD]),
  );
  expect(new Set(of(storefrontPrincipal.principalId).map(({ workloadKey }) => workloadKey))).toEqual(
    new Set([STOREFRONT_CLIENT_WORKLOAD, STOREFRONT_MERCHANDISE_WORKLOAD]),
  );
  for (const principal of [storefrontPrincipal, akrosStorefrontPrincipal]) {
    for (const { legalEntityId } of of(principal.principalId)) {
      expect(legalEntityId).toBe(principal.legalEntityId);
    }
  }
  // Non-storefront workloads keep acting across the tenant: no company is registered for them.
  for (const principal of [commercePortalPrincipal, crmPartyIntakePrincipal]) {
    expect(of(principal.principalId).every(({ legalEntityId }) => legalEntityId === undefined)).toBe(true);
  }
});

it('leaves every other service principal unbound and names its carrier gap', () => {
  const bound = new Set(reviewedWorkloadBindings().map((binding) => binding.principalId));
  const unmapped = unmappedServicePrincipals.map((entry) => entry.principalId);
  expect(new Set(unmapped)).toEqual(
    new Set([
      privacyConsentPrincipal.principalId,
      marketRetirementPrincipal.principalId,
      kavarnaMarketAuthorityPrincipal.principalId,
    ]),
  );
  for (const principalId of unmapped) {
    expect(bound.has(principalId)).toBe(false);
  }
  for (const entry of unmappedServicePrincipals) {
    expect(entry.reason.length).toBeGreaterThan(0);
    expect(entry.carrier.length).toBeGreaterThan(0);
  }
  // The MCP bot is admitted by the gateway protocol, not by a workload binding either.
  expect(bound.has(agentBotPrincipal.principalId)).toBe(false);
});

it('derives the fixture role key of a persona from its stable identity, never from a label', () => {
  expect(demoPrincipalRoleKey(demoHumanAccounts[0].principalId)).toBe('sales-leadership');
  expect(demoPrincipalRoleKey(companyHumanAccounts[0].principalId)).toBe('crm-administration');
  expect(demoPrincipalRoleKey('72000000-0000-4000-8000-000000000021')).toBe('management');
  expect(demoPrincipalRoleKey('unknown-principal')).toBe('demo:unknown-principal');
});
