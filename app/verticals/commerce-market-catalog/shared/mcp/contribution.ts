import { defineOntosMcpContribution } from '@app/core-runtime';

export const commerceMarketCatalogMcpContribution = defineOntosMcpContribution({
  actions: {
    'activate-market': {
      title: {
        cs: 'Aktivovat obchodní trh',
        en: 'Activate a commerce market',
      },
    },
    'associate-storefront': {
      title: {
        cs: 'Přiřadit e-shop k trhu',
        en: 'Associate a storefront with a market',
      },
    },
    'create-market': {
      title: {
        cs: 'Vytvořit obchodní trh',
        en: 'Create a commerce market',
      },
    },
    'remove-storefront-association': {
      title: {
        cs: 'Odebrat přiřazení e-shopu k trhu',
        en: 'Remove a storefront market association',
      },
    },
    'retire-market': {
      destructive: true,
      title: {
        cs: 'Vyřadit obchodní trh',
        en: 'Retire a commerce market',
      },
    },
    'revise-market-definition': {
      title: {
        cs: 'Upravit definici obchodního trhu',
        en: 'Revise a commerce market definition',
      },
    },
    'revise-storefront-association': {
      title: {
        cs: 'Upravit přiřazení e-shopu k trhu',
        en: 'Revise a storefront market association',
      },
    },
    'suspend-market': {
      title: {
        cs: 'Pozastavit obchodní trh',
        en: 'Suspend a commerce market',
      },
    },
  },
  approvals: false,
  description: {
    cs: 'Definice a životní cyklus obchodních trhů, jejich historie a propojení s e-shopy.',
    en: 'Commerce market definitions, lifecycle, history and storefront associations.',
  },
  keywords: 'trh obchodní trhy země měna e-shop provozovna commerce market country currency storefront eligibility',
  label: {
    cs: 'Obchodní trhy',
    en: 'Commerce markets',
  },
  reads: {
    'current-market-catalog': {
      title: {
        cs: 'Aktuální katalog obchodních trhů',
        en: 'Current commerce market catalog',
      },
    },
    'eligible-market-tuples': {
      title: {
        cs: 'Povolené kombinace obchodního trhu',
        en: 'Eligible market combinations',
      },
    },
    'market-history': {
      title: {
        cs: 'Historie obchodního trhu',
        en: 'Commerce market history',
      },
    },
    'pricing-current-market-evidence': 'hidden',
    'resolve-commerce-market': 'hidden',
    'verify-market-eligibility-v1': 'hidden',
  },
});
