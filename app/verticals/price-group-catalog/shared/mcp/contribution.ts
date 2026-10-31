import { defineOntosMcpContribution } from '@app/core-runtime';

export const priceGroupCatalogMcpContribution = defineOntosMcpContribution({
  actions: {
    'create-price-group': {
      title: {
        cs: 'Vytvořit cenovou skupinu',
        en: 'Create a price group',
      },
    },
    'create-price-group-definition-revision': {
      title: {
        cs: 'Vytvořit revizi definice cenové skupiny',
        en: 'Create a price group definition revision',
      },
    },
    'retire-price-group': {
      destructive: true,
      title: {
        cs: 'Vyřadit cenovou skupinu',
        en: 'Retire a price group',
      },
    },
  },
  approvals: false,
  description: {
    cs: 'Cenové skupiny, jejich definice, revize a vyřazování.',
    en: 'Price groups, their definitions, revisions and retirement.',
  },
  keywords: 'cenová skupina ceník katalog cena definice price group catalog pricing definition',
  label: {
    cs: 'Katalog cenových skupin',
    en: 'Price group catalog',
  },
  reads: {
    'price-group-definition': {
      title: {
        cs: 'Definice cenové skupiny',
        en: 'Price group definition',
      },
    },
    'validate-price-group-compatibility': 'hidden',
  },
});
