import { expect, it } from 'effect-rstest';
import { Schema } from 'effect';
import { WorkloadKeySchema } from '../../packages/core-runtime/src/authorization/access-declaration.ts';

import {
  IDENTITY_PROVIDER_WORKLOAD,
  STOREFRONT_CLIENT_WORKLOAD,
  STOREFRONT_INQUIRY_WORKLOAD,
  STOREFRONT_MERCHANDISE_WORKLOAD,
  akrosStorefrontPrincipal,
  commerceEnrollmentOperatorActionKeys,
  commercePortalPrincipal,
  companyHumanAccounts,
  companyRoles,
  crmDemoRoles,
  crmReadCapability,
  crmWriteCapability,
  crmAssignCapability,
  crmNavigationKeys,
  tenantAdministratorCrmRole,
  companyAgentKeyAdministratorRole,
  demoHumanAccounts,
  demoLegalEntityIds,
  demoModuleIds,
  demoPrincipalRoleKey,
  demoRoles,
  demoShellRoutingRoleKey,
  eshopDemoRoles,
  facilityPersonalAgendaCapability,
  pipelineReadCapability,
  pipelineEntrustCapability,
  pipelineSearchCapability,
  pipelineWriteCapability,
  privacyConsentPrincipal,
  rentalDemoRoles,
  retiredServiceRoles,
  reviewedDemoAssignments,
  reviewedMachinePrincipals,
  reviewedWorkloadBindings,
  siamparkRentalPersonas,
  storefrontPrincipal,
  unmappedServicePrincipals,
} from '../demo/permissions.mts';
import type { DemoRole } from '../demo/permissions.mts';

const everyRole = (): readonly (readonly [string, DemoRole])[] => [
  ...Object.entries(demoRoles).map(([key, role]) => [`demo.${key}`, role] as const),
  ...Object.entries(rentalDemoRoles).map(([key, role]) => [`rental.${key}`, role] as const),
  ...Object.entries(crmDemoRoles).map(([key, role]) => [`crm.${key}`, role] as const),
  ...Object.entries(eshopDemoRoles).map(([key, role]) => [`eshop.${key}`, role] as const),
];

it('names every module of every reviewed Role explicitly, never a wildcard or an all-module grant', () => {
  const knownModules = new Set<string>([...demoModuleIds, 'core.identity', 'core.shell', 'privacy.core']);
  for (const [label, role] of everyRole()) {
    for (const moduleId of Object.keys(role.modules)) {
      expect({ known: knownModules.has(moduleId), label, moduleId }).toEqual({ known: true, label, moduleId });
    }
    expect({ label, wildcard: JSON.stringify(role).includes('"*"') }).toEqual({ label, wildcard: false });
  }
});

it('never names read_all/write_all aliases in any reviewed policy', () => {
  for (const [label, role] of everyRole()) {
    const broad = Object.values(role.capabilityKeys ?? {})
      .flat()
      .filter((key) => /\.(?:read_all|write_all)$/u.test(key));
    expect({ broad, label }).toEqual({ broad: [], label });
  }
});

it('keeps every restricted module to exactly its named capabilities', () => {
  for (const [label, role] of everyRole()) {
    for (const moduleId of role.restrictedModules ?? []) {
      expect({ declared: moduleId in role.modules, label, moduleId }).toEqual({ declared: true, label, moduleId });
      expect((role.capabilityKeys?.[moduleId] ?? []).length).toBeGreaterThan(0);
    }
  }
});

it('keeps the CRM narrowing explicit instead of granting the whole module to a representative', () => {
  expect(crmDemoRoles.crmRep.restrictedModules).toEqual(['demo.crm']);
  expect(crmDemoRoles.crmRep.capabilityKeys?.['demo.crm']).toEqual([
    ...crmNavigationKeys,
    crmReadCapability,
    crmWriteCapability,
  ]);
  expect(crmDemoRoles.crmManager.capabilityKeys?.['demo.crm']).toEqual([
    ...crmNavigationKeys,
    crmReadCapability,
    crmWriteCapability,
    crmAssignCapability,
  ]);
  // A representative never reaches party.registry: its company-wide customer list would bypass the filter.
  expect('party.registry' in crmDemoRoles.crmRep.modules).toBe(false);
});

it('pins each service principal to its own company and gives it no Role of its own', () => {
  expect(privacyConsentPrincipal.legalEntityId).toBeDefined();
  expect(commerceEnrollmentOperatorActionKeys.every((key) => key.startsWith('commerce.customer-context.'))).toBe(true);
  // Every reviewed Role belongs to a person profile; a service principal is never a Role holder.
  const roleLabels = everyRole().map(([, role]) => role.label);
  expect(roleLabels).not.toContain('Commerce portal (service)');
  expect(roleLabels).not.toContain('CRM Party intake');
  expect(roleLabels).not.toContain('Storefront (API)');
});

it('maps every reviewed machine identity to exactly the workload keys a carrier declares', () => {
  const bindings = reviewedWorkloadBindings();
  // The storefronts and the portal run the portal-enrollment journey; only the portal is the identity provider.
  // Each storefront binding is registered for the storefront's own company (D6).
  const kavarna = { legalEntityId: storefrontPrincipal.legalEntityId, principalId: storefrontPrincipal.principalId };
  const sroubshop = {
    legalEntityId: akrosStorefrontPrincipal.legalEntityId,
    principalId: akrosStorefrontPrincipal.principalId,
  };
  expect(bindings).toEqual([
    { ...kavarna, workloadKey: STOREFRONT_CLIENT_WORKLOAD },
    { ...kavarna, workloadKey: STOREFRONT_MERCHANDISE_WORKLOAD },
    { ...sroubshop, workloadKey: STOREFRONT_CLIENT_WORKLOAD },
    { ...sroubshop, workloadKey: STOREFRONT_MERCHANDISE_WORKLOAD },
    { ...sroubshop, workloadKey: STOREFRONT_INQUIRY_WORKLOAD },
    { principalId: commercePortalPrincipal.principalId, workloadKey: STOREFRONT_CLIENT_WORKLOAD },
    { principalId: commercePortalPrincipal.principalId, workloadKey: IDENTITY_PROVIDER_WORKLOAD },
  ]);
  // Every bound principal has a principal row, and every row is a machine identity, never a person.
  const machineIds = new Set(reviewedMachinePrincipals.map((machine) => machine.principalId));
  for (const binding of bindings) {
    expect(machineIds.has(binding.principalId)).toBe(true);
    expect(Schema.is(WorkloadKeySchema)(binding.workloadKey)).toBe(true);
  }
  // The unbound machine identities are exactly the ones whose carrier declares no workload key.
  const boundIds = new Set(bindings.map((binding) => binding.principalId));
  for (const entry of unmappedServicePrincipals) {
    expect(boundIds.has(entry.principalId)).toBe(false);
  }
});

it('keeps every machine identity out of the reviewed person assignments', () => {
  const assigned = new Set(reviewedDemoAssignments().map((entry) => entry.principalId));
  for (const machine of reviewedMachinePrincipals) {
    expect(assigned.has(machine.principalId)).toBe(false);
  }
});

it('keeps the reviewed assignment set free of legacy tuple vocabulary', () => {
  const encoded = JSON.stringify(reviewedDemoAssignments());
  for (const retired of ['scoped_role', 'context_permission', 'action_grant', 'module_access']) {
    expect(encoded).not.toContain(retired);
  }
  // A Party relationship capability is domain vocabulary, not a tuple's relation property.
  expect(encoded).not.toContain('"relation":');
  // The e-shop and CRM companies each keep their own reviewed personas.
  const assignedCompanies = new Set(companyHumanAccounts.map((account) => account.legalEntityId));
  expect(assignedCompanies.size).toBeGreaterThan(1);
  expect(companyRoles.crmAdmin.companyAdmin).toBe(true);
});

it('retires each service Role together with the caller that needed it', () => {
  // A Role that nothing writes is the retired scoped-role model under a new name, so each removed service
  // Role names the native protocol that replaced its caller.
  expect(retiredServiceRoles.length).toBeGreaterThan(0);
  for (const entry of retiredServiceRoles) {
    expect(entry.reason.length).toBeGreaterThan(0);
    expect(entry.role.length).toBeGreaterThan(0);
  }
  expect(retiredServiceRoles.some((entry) => entry.reason.includes('native service-key protocol'))).toBe(true);
  expect(retiredServiceRoles.some((entry) => entry.reason.includes('workload'))).toBe(true);
});

it('isolates the tenant owner and every persona by its own reviewed role key', () => {
  const assignments = reviewedDemoAssignments();
  const roleKeysOf = (principalId: string) =>
    new Set(assignments.filter((entry) => entry.principalId === principalId).map((entry) => entry.roleKey));
  expect(roleKeysOf(demoHumanAccounts[0].principalId)).toEqual(
    new Set([
      'sales-leadership',
      demoShellRoutingRoleKey,
      'tenant-administrator-crm-0020',
      'tenant-administrator-crm-0021',
      'tenant-administrator-crm-0022',
      'tenant-administrator-pipeline-0020',
      'tenant-administrator-pipeline-0021',
      'company-agent-keys-0020',
    ]),
  );
  expect(roleKeysOf(siamparkRentalPersonas[3].principalId)).toEqual(
    new Set([demoPrincipalRoleKey(siamparkRentalPersonas[3].principalId), demoShellRoutingRoleKey]),
  );
  expect(new Set(demoLegalEntityIds).size).toBe(demoLegalEntityIds.length);
});

it('names exact CRM record reach independently from write and reassignment', () => {
  for (const role of [crmDemoRoles.crmAdmin, crmDemoRoles.crmManager, tenantAdministratorCrmRole]) {
    expect(role.capabilitySelectors?.[crmReadCapability]).toBe('all');
    expect(role.capabilityKeys?.['demo.crm']).toContain(crmWriteCapability);
    expect(role.capabilityKeys?.['demo.crm']).toContain(crmAssignCapability);
  }
  expect(crmDemoRoles.crmRep.capabilitySelectors[crmReadCapability]).toBe('assigned');
  expect(crmDemoRoles.crmRep.capabilityKeys['demo.crm']).not.toContain(crmAssignCapability);
  const external = siamparkRentalPersonas[3].role;
  expect(external.capabilitySelectors[crmReadCapability]).toBe('entrusted');
  expect(external.capabilityKeys['demo.crm']).not.toContain(crmWriteCapability);
  expect(external.capabilityKeys['demo.crm']).not.toContain(crmAssignCapability);
  expect(external.capabilityKeys['facility.operations']).toContain('facility.operations.api-records.read');
  expect(external.capabilityKeys['facility.operations']).not.toContain('facility.operations.records-restricted.read');
  expect(external.capabilityKeys['facility.operations']).not.toContain('facility.operations.apply-command.write');
  expect(external.capabilityKeys['facility.operations']).toContain(facilityPersonalAgendaCapability);
  expect(external.capabilityModes[facilityPersonalAgendaCapability]).toEqual(['run']);
  expect(external.modules['demo.sales-pipeline']).toBe('read');
  expect(external.capabilitySelectors[pipelineReadCapability]).toBe('entrusted');
  expect(external.capabilityKeys['demo.sales-pipeline']).not.toContain(pipelineWriteCapability);
  expect(external.capabilityKeys['demo.sales-pipeline']).not.toContain(pipelineEntrustCapability);
  expect(external.capabilityKeys['demo.sales-pipeline']).not.toContain(pipelineSearchCapability);
});

it('assigns company-agent key reads only in explicit company roles, not tenant context', () => {
  const assignments = reviewedDemoAssignments().filter(({ role }) => role === companyAgentKeyAdministratorRole);
  expect(assignments.length).toBeGreaterThan(0);
  for (const assignment of assignments) {
    expect(assignment.legalEntityId).toBeDefined();
    expect(assignment.role.capabilityKeys?.['core.identity']).toEqual([
      'core.identity.company-agent-key.list-managed',
      'core.identity.company-agent-key.read-personal-data',
      'core.identity.company-agent-key.read-authentication-metadata',
    ]);
    expect(assignment.role.restrictedModules).toEqual(['core.identity']);
  }
});
