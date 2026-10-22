import { defineOntosMcpContribution } from '@app/core-runtime';

export const pricingMcpContribution = defineOntosMcpContribution({
  actions: {
    'compensate-currency-support-recovery': 'hidden',
    'define-commercial-fee': {
      title: {
        cs: 'Definovat obchodní poplatek',
        en: 'Define a commercial fee',
      },
    },
    'define-price': {
      title: {
        cs: 'Definovat cenu',
        en: 'Define a price',
      },
    },
    'manage-commitment-confirmation': 'hidden',
    'manage-contractual-discount': {
      destructive: true,
      title: {
        cs: 'Spravovat smluvní slevu',
        en: 'Manage a contractual discount',
      },
    },
    'manage-product-commercial-fees-bulk': {
      title: {
        cs: 'Hromadně spravovat poplatky produktů',
        en: 'Manage product commercial fees in bulk',
      },
    },
    'manage-product-prices-bulk': {
      title: {
        cs: 'Hromadně spravovat ceny produktů',
        en: 'Manage product prices in bulk',
      },
    },
    'manage-quantity-tier': {
      destructive: true,
      title: {
        cs: 'Spravovat množstevní pásmo',
        en: 'Manage a quantity tier',
      },
    },
    'manage-quotation': {
      title: {
        cs: 'Vystavit cenovou nabídku',
        en: 'Issue a quotation',
      },
    },
    'manage-zero-floor-authorization': {
      destructive: true,
      title: {
        cs: 'Spravovat oprávnění k nulové ceně',
        en: 'Manage a zero price floor authorization',
      },
    },
    'revise-commercial-fee': {
      title: {
        cs: 'Upravit obchodní poplatek',
        en: 'Revise a commercial fee',
      },
    },
    'revise-price': {
      title: {
        cs: 'Upravit cenu',
        en: 'Revise a price',
      },
    },
    'set-supported-currencies': {
      title: {
        cs: 'Nastavit podporované měny',
        en: 'Set supported currencies',
      },
    },
  },
  approvals: false,
  description: {
    cs: 'Ceny a ceníky, měny, obchodní poplatky, smluvní slevy, množstevní pásma a cenové nabídky.',
    en: 'Prices and schedules, currencies, commercial fees, contractual discounts, quantity tiers and quotations.',
  },
  keywords:
    'cena ceník cenotvorba měna poplatek sleva nabídka množství pásmo nulová cena pricing price schedule currency fee discount quotation quantity tier',
  label: {
    cs: 'Cenotvorba',
    en: 'Pricing',
  },
  reads: {
    'commercial-fee-definition': {
      title: {
        cs: 'Definice obchodního poplatku',
        en: 'Commercial fee definition',
      },
    },
    'commercial-fee-result-lookup': 'hidden',
    'commercial-fee-schedule': {
      title: {
        cs: 'Sazebník obchodních poplatků',
        en: 'Commercial fee schedule',
      },
    },
    'contractual-discount-result-lookup': 'hidden',
    'currency-support-result-lookup': 'hidden',
    'current-pricing-decision': {
      title: {
        cs: 'Aktuální cenové posouzení',
        en: 'Current pricing decision',
      },
    },
    'current-supported-currencies': {
      title: {
        cs: 'Aktuálně podporované měny',
        en: 'Current supported currencies',
      },
    },
    'exact-price-resolution': 'hidden',
    'price-definition': {
      title: {
        cs: 'Definice ceny',
        en: 'Price definition',
      },
    },
    'price-result-lookup': 'hidden',
    'price-schedule': {
      title: {
        cs: 'Ceník',
        en: 'Price schedule',
      },
    },
    'quantity-tier-result-lookup': 'hidden',
    'quotation-result-lookup': 'hidden',
    'zero-floor-authorization-result-lookup': 'hidden',
  },
});
