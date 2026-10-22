import { defineOntosMcpContribution } from '@app/core-runtime';

export const assortmentMcpContribution = defineOntosMcpContribution({
  actions: {
    'create-applicability-binding': {
      title: {
        cs: 'Přiřadit pravidlo sortimentu k obchodnímu kontextu',
        en: 'Bind an assortment rule to a commercial context',
      },
    },
    'create-closed-assortment-boundary': {
      title: {
        cs: 'Vytvořit uzavřené vymezení sortimentu',
        en: 'Create a closed assortment boundary',
      },
    },
    'create-rule': {
      title: {
        cs: 'Vytvořit pravidlo sortimentu',
        en: 'Create an assortment rule',
      },
    },
    'create-rule-revision': {
      title: {
        cs: 'Vytvořit revizi pravidla sortimentu',
        en: 'Create an assortment rule revision',
      },
    },
    'end-applicability-binding': {
      destructive: true,
      title: {
        cs: 'Ukončit přiřazení pravidla sortimentu',
        en: 'End an assortment rule binding',
      },
    },
    'end-closed-assortment-boundary': {
      destructive: true,
      title: {
        cs: 'Ukončit uzavřené vymezení sortimentu',
        en: 'End a closed assortment boundary',
      },
    },
    'issue-assortment-commitment-confirmation': 'hidden',
    'replace-applicability-binding': {
      title: {
        cs: 'Nahradit přiřazení pravidla sortimentu',
        en: 'Replace an assortment rule binding',
      },
    },
    'replace-closed-assortment-boundary': {
      title: {
        cs: 'Nahradit uzavřené vymezení sortimentu',
        en: 'Replace a closed assortment boundary',
      },
    },
    'retire-rule': {
      destructive: true,
      title: {
        cs: 'Vyřadit pravidlo sortimentu',
        en: 'Retire an assortment rule',
      },
    },
  },
  approvals: false,
  description: {
    cs: 'Pravidla viditelnosti a nákupu produktů, vymezení sortimentu a vysvětlení rozhodnutí.',
    en: 'Product visibility and purchasing rules, assortment boundaries and decision explanations.',
  },
  keywords:
    'sortiment pravidlo prodej viditelnost nákup omezení zákazník produkt assortment rule visibility purchase boundary',
  label: {
    cs: 'Sortiment a pravidla prodeje',
    en: 'Assortment and sales rules',
  },
  reads: {
    configuration: {
      title: {
        cs: 'Nastavení sortimentu',
        en: 'Assortment configuration',
      },
    },
    'decision-explanation': {
      title: {
        cs: 'Vysvětlení rozhodnutí o sortimentu',
        en: 'Assortment decision explanation',
      },
    },
    purchase: {
      title: {
        cs: 'Posouzení možnosti nákupu sortimentu',
        en: 'Assortment purchase assessment',
      },
    },
    visibility: {
      title: {
        cs: 'Posouzení viditelnosti sortimentu',
        en: 'Assortment visibility assessment',
      },
    },
  },
});
