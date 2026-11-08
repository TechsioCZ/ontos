import { expect, it } from 'effect-rstest';

import { crmDemoRoles, demoRoles, eshopDemoRoles } from '../demo/permissions.mts';
import type { DemoRole } from '../demo/permissions.mts';

const companyAdminRoles: readonly (readonly [string, DemoRole])[] = [
  ['headOfSales', demoRoles.headOfSales],
  ['crmAdmin', crmDemoRoles.crmAdmin],
  ['eshopAdmin', eshopDemoRoles.eshopAdmin],
  ['akrosAdmin', eshopDemoRoles.akrosAdmin],
];

const nonAdminRoles: readonly (readonly [string, DemoRole])[] = [
  ['accountant', demoRoles.accountant],
  ['salesRep', demoRoles.salesRep],
  ['warehouse', demoRoles.warehouse],
  ['crmManager', crmDemoRoles.crmManager],
  ['crmRep', crmDemoRoles.crmRep],
  ['fulfilment', eshopDemoRoles.fulfilment],
];

it('marks exactly the reviewed company administrators, never inferred from a job or a module', () => {
  for (const [label, role] of companyAdminRoles) {
    expect({ companyAdmin: role.companyAdmin, label }).toEqual({ companyAdmin: true, label });
  }
  for (const [label, role] of nonAdminRoles) {
    expect(role.companyAdmin, label).toBeUndefined();
  }
});

it('keeps the tenant owner explicit, never a company administrator by accident', () => {
  expect(demoRoles.headOfSales.tenantOwner).toBe(true);
  for (const [label, role] of nonAdminRoles) {
    expect(role.tenantOwner, label).toBeUndefined();
  }
  // Only the trading company's head of sales owns the tenant; the rental and e-shop administrators do not.
  expect(demoRoles.headOfSales.tenantOwner).toBe(true);
  const crmAdmin: DemoRole = crmDemoRoles.crmAdmin;
  expect(crmAdmin.tenantOwner).toBeUndefined();
});

it('never grants a company administrator every module of the release by default', () => {
  // The reviewed administrators name their modules explicitly; none is a wildcard or an all-actions grant.
  for (const [label, role] of companyAdminRoles) {
    expect({ label, modules: Object.keys(role.modules).length > 0 }).toEqual({ label, modules: true });
    expect(JSON.stringify(role)).not.toContain('"*"');
  }
});
