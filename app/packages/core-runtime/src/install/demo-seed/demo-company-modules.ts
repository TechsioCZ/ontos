/**
 * Seed data for the fixed synthetic development tenant: the modules its demo companies activate. Kept apart from the
 * install code so Core itself never names a vertical module.
 */
export const demoCompanyActiveModuleKeys: readonly string[] = Object.freeze([
  'property.portfolio',
  'property.leasing',
  'legal.agreements',
]);
