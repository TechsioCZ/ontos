import { defineOntosMcpContribution } from '@app/core-runtime';

export const storefrontRegistryMcpContribution = defineOntosMcpContribution({
  actions: {
    'register-storefront-application': {
      title: {
        cs: 'Zaregistrovat aplikaci e-shopu',
        en: 'Register a storefront application',
      },
    },
    'revise-storefront-application': {
      title: {
        cs: 'Upravit registraci aplikace e-shopu',
        en: 'Revise a storefront application',
      },
    },
  },
  approvals: false,
  description: {
    cs: 'Registrace aplikací e-shopů a správa jejich aktuálních definic.',
    en: 'Storefront application registration and current definition administration.',
  },
  keywords: 'e-shop aplikace registr registrace konfigurace storefront application registry registration configuration',
  label: {
    cs: 'Registr e-shopů',
    en: 'Storefront registry',
  },
  reads: {
    'current-storefront-application': {
      title: {
        cs: 'Aktuální definice aplikace e-shopu',
        en: 'Current storefront application',
      },
    },
    'verify-current-storefront-application-v1': 'hidden',
  },
});
