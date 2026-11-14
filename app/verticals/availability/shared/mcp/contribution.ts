import { defineOntosMcpContribution } from '@app/core-runtime';

export const availabilityMcpContribution = defineOntosMcpContribution({
  actions: {},
  approvals: false,
  description: {
    cs: 'Modul dostupnosti zboží; zatím bez veřejných operací pro čtení nebo změny.',
    en: 'Product availability module; no public read or write operations are currently declared.',
  },
  keywords: 'dostupnost zboží produkt sklad zásoba availability product stock inventory',
  label: {
    cs: 'Dostupnost zboží',
    en: 'Product availability',
  },
  reads: {},
});
