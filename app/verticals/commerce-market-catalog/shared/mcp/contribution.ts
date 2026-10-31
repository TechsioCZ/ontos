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
      description: {
        cs: 'Požádá o vyřazení trhu. Výsledek je obvykle „pending“: vyřazení dokončí OntOS na pozadí po potvrzení dopadu v zákaznickém kontextu. Konečný stav (completed nebo failed s důvodem) ukáže čtení „Stav vyřazení obchodního trhu“ s vráceným retirementIntentId.',
        en: 'Requests Market retirement. The result is usually "pending": OntOS completes it in the background after Customer Context confirms the impact. Read "Commerce market retirement status" with the returned retirementIntentId for the final completed or failed (with reason) outcome.',
      },
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
    'market-retirement-status': {
      description: {
        cs: 'Stav jednoho požadavku na vyřazení trhu: pending (probíhá, s fází), completed (trh je vyřazen) nebo failed (nevyřazen, s typovaným důvodem, např. replacement_impact_unresolved, když na trh stále odkazují živé záznamy).',
        en: 'State of one retirement request: pending (with stage), completed (the Market is retired) or failed (not retired, with a typed reason such as replacement_impact_unresolved while live records still reference the Market).',
      },
      title: {
        cs: 'Stav vyřazení obchodního trhu',
        en: 'Commerce market retirement status',
      },
    },
    'pricing-current-market-evidence': 'hidden',
    'resolve-commerce-market': 'hidden',
    'verify-market-eligibility-v1': 'hidden',
  },
});
