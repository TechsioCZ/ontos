import { defineOntosMcpContribution } from '@app/core-runtime';

export const taxMcpContribution = defineOntosMcpContribution({
  actions: {
    'correct-tax-rule-revision': {
      title: {
        cs: 'Opravit revizi daňového pravidla',
        en: 'Correct a tax rule revision',
      },
    },
    'create-tax-rule': {
      title: {
        cs: 'Vytvořit daňové pravidlo',
        en: 'Create a tax rule',
      },
    },
    'create-tax-rule-revision': {
      title: {
        cs: 'Vytvořit revizi daňového pravidla',
        en: 'Create a tax rule revision',
      },
    },
    'declare-seller-vat-regime': {
      title: {
        cs: 'Nastavit režim DPH prodávajícího',
        en: 'Declare a seller VAT regime',
      },
    },
    'end-tax-rule-revision': {
      destructive: true,
      title: {
        cs: 'Ukončit revizi daňového pravidla',
        en: 'End a tax rule revision',
      },
    },
    'finalize-order-tax': {
      title: {
        cs: 'Uzavřít daňový výpočet objednávky',
        en: 'Finalize order tax',
      },
    },
    'import-seller-vat-regime-declarations': {
      title: {
        cs: 'Importovat režimy DPH prodávajících',
        en: 'Import seller VAT regime declarations',
      },
    },
  },
  approvals: false,
  description: {
    cs: 'Daňová pravidla a revize, režimy DPH prodávajících, výpočty daně a daňové podklady objednávek.',
    en: 'Tax rules and revisions, seller VAT regimes, tax evaluations and order tax records.',
  },
  keywords: 'daň daně DPH sazba režim prodávající objednávka pravidlo oprava tax VAT rule rate seller order correction',
  label: {
    cs: 'Daně a DPH',
    en: 'Tax and VAT',
  },
  reads: {
    'applicable-tax-rule-set': {
      title: {
        cs: 'Použitelná daňová pravidla',
        en: 'Applicable tax rules',
      },
    },
    'final-order-tax': {
      title: {
        cs: 'Konečná daň objednávky',
        en: 'Final order tax',
      },
    },
    'seller-vat-regime-at-instant': {
      title: {
        cs: 'Režim DPH prodávajícího k datu',
        en: 'Seller VAT regime at a given time',
      },
    },
    'seller-vat-regime-history': {
      title: {
        cs: 'Historie režimu DPH prodávajícího',
        en: 'Seller VAT regime history',
      },
    },
    'tax-correction-preview': {
      title: {
        cs: 'Náhled opravy daně',
        en: 'Tax correction preview',
      },
    },
    'tax-evaluation': {
      title: {
        cs: 'Výpočet daně',
        en: 'Tax evaluation',
      },
    },
    'tax-materiality-comparison': {
      title: {
        cs: 'Porovnání významnosti daňových změn',
        en: 'Tax materiality comparison',
      },
    },
    'tax-privacy-owner-coverage': 'hidden',
    'tax-rule-history': {
      title: {
        cs: 'Historie daňového pravidla',
        en: 'Tax rule history',
      },
    },
  },
});
