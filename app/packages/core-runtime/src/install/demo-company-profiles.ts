/** Fixed, synthetic development companies; these identifiers never select trusted request scope. */
export { rentalDemoBrandProfiles } from './demo-rental-brand-profiles.ts';

export const demoCompanyTenantId = '70000000-0000-4000-8000-000000000020';
export const commercialDemoCompany = {
  legalEntityId: '71000000-0000-4000-8000-000000000020',
  legalName: 'Obchodní firma',
} as const;
export const rentalDemoCompany = {
  legalEntityId: '71000000-0000-4000-8000-000000000021',
  legalName: 'Nájempark',
} as const;
/** Wholesale company of the CRM demo (sales reps with assigned clients). */
export const crmDemoCompany = {
  legalEntityId: '71000000-0000-4000-8000-000000000022',
  legalName: 'Velkoobchod Hanák s.r.o.',
} as const;
/** Coffee e-shop of the storefront demo (products, variants, orders). */
export const eshopDemoCompany = {
  legalEntityId: '71000000-0000-4000-8000-000000000023',
  legalName: 'Kavárna Doma s.r.o.',
} as const;
export const akrosDemoCompany = {
  legalEntityId: '71000000-0000-4000-8000-000000000024',
  legalName: 'AKROS (demo)',
} as const;
/** Every fixed synthetic company with its synthetic registration number. */
export const additionalDemoCompanies = [
  { ...crmDemoCompany, registrationNumber: 'DEMO-HANAK-CRM' },
  { ...eshopDemoCompany, registrationNumber: 'DEMO-KAVARNA-ESHOP' },
  { ...akrosDemoCompany, registrationNumber: 'DEMO-AKROS' },
] as const;
