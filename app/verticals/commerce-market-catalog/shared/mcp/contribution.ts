import { defineOntosMcpContribution, OntosMcpHidden } from '@app/core-runtime';

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
    // Owner-internal PREPARE/ABORT protocol for retire-market, bound to its original invocation and actor.
    // Agents use retire-market and its recovery read, never admission management as a standalone tool.
    'manage-market-retirement-admission': 'hidden',
    'remove-storefront-association': {
      title: {
        cs: 'Odebrat přiřazení e-shopu k trhu',
        en: 'Remove a storefront market association',
      },
    },
    'request-search-rebuild': {
      title: { cs: 'Vyžádat obnovu vyhledávacího indexu trhů', en: 'Request a market search index rebuild' },
    },
    'retire-market': {
      description: {
        cs: 'Vyřadí trh a vrátí MarketLifecycleResult. Při nevyřízeném vypořádání rezervace v zákaznickém kontextu nese odpověď 503 již potvrzený výsledek v committedResult. Nepoužívejte nový idempotency klíč; zopakujte původní klíč nebo použijte čtení Obnova efektu vyřazení obchodního trhu.',
        en: 'Retires a Market and returns MarketLifecycleResult. If Customer Context settlement remains pending, HTTP 503 carries the committed result in committedResult. Do not retry with a new idempotency key; replay the original key or use the Commerce market retirement effect recovery read.',
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
    // Owner-to-owner or enrolled source-workload integration read; never a general agent tool.
    'assortment-fixture-market-association': OntosMcpHidden,
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
    'market-administration': 'hidden',
    'market-history': {
      title: {
        cs: 'Historie obchodního trhu',
        en: 'Commerce market history',
      },
    },
    'market-retirement-effect-recovery': {
      description: {
        cs: 'Obnoví původní efekt vyřazení podle sourceActionInvocationId: NOT_FOUND (žádný efekt), PENDING (přijatý, dosud nevyřízený), ABORTED (vrácený) nebo COMMITTED s uloženým výsledkem trhu. Použijte po neúspěšném vyřazení místo opakování s novým klíčem.',
        en: 'Recovers the original retirement effect by sourceActionInvocationId: NOT_FOUND (no effect), PENDING (accepted, not yet settled), ABORTED (released) or COMMITTED with the stored Market result. Use it after an indeterminate retire attempt instead of retrying with a fresh key.',
      },
      title: {
        cs: 'Obnova efektu vyřazení obchodního trhu',
        en: 'Commerce market retirement effect recovery',
      },
    },
    'pricing-current-market-evidence': 'hidden',
    'resolve-commerce-market': 'hidden',
    'verify-market-eligibility-v1': 'hidden',
  },
});
