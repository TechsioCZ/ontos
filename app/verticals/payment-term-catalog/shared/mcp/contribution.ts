import { defineOntosMcpContribution } from '@app/core-runtime';

export const paymentTermCatalogMcpContribution = defineOntosMcpContribution({
  actions: {
    'accept-payment-term-source-statement': {
      title: {
        cs: 'Přijmout zdrojové údaje platební podmínky',
        en: 'Accept a payment term source statement',
      },
    },
    'configure-payment-term-source-authority': {
      title: {
        cs: 'Nastavit autoritu zdroje platebních podmínek',
        en: 'Configure payment term source authority',
      },
    },
    'correct-payment-term': {
      title: {
        cs: 'Opravit platební podmínku',
        en: 'Correct a payment term',
      },
    },
    'create-payment-term': {
      title: {
        cs: 'Vytvořit platební podmínku',
        en: 'Create a payment term',
      },
    },
    'reconcile-payment-term-reference': {
      title: {
        cs: 'Sladit odkaz na platební podmínku',
        en: 'Reconcile a payment term reference',
      },
    },
    'retire-payment-term': {
      destructive: true,
      title: {
        cs: 'Vyřadit platební podmínku',
        en: 'Retire a payment term',
      },
    },
  },
  approvals: false,
  description: {
    cs: 'Platební podmínky, jejich historie, zdrojové záznamy a správa autority zdrojů.',
    en: 'Payment terms, their history, source records and source authority administration.',
  },
  keywords: 'platební podmínky splatnost platba katalog zdroj historie payment terms due date catalog source authority',
  label: {
    cs: 'Katalog platebních podmínek',
    en: 'Payment term catalog',
  },
  reads: {
    'current-payment-terms': {
      title: {
        cs: 'Aktuální platební podmínky',
        en: 'Current payment terms',
      },
    },
    'payment-term-history': {
      title: {
        cs: 'Historie platební podmínky',
        en: 'Payment term history',
      },
    },
    'payment-term-source-record-history': {
      title: {
        cs: 'Historie zdrojového záznamu platební podmínky',
        en: 'Payment term source record history',
      },
    },
    'payment-term-source-statement': {
      title: {
        cs: 'Zdrojové údaje platební podmínky',
        en: 'Payment term source statement',
      },
    },
  },
});
