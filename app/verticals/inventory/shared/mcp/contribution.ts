import { defineOntosMcpContribution } from '@app/core-runtime';

export const inventoryMcpContribution = defineOntosMcpContribution({
  actions: {
    'change-stock-sharing-eligibility': {
      title: {
        cs: 'Změnit pravidla sdílení zásob',
        en: 'Change stock sharing eligibility',
      },
    },
    'compensate-inventory-pre-commit': 'hidden',
    'correct-catalog-to-stock-binding': {
      title: {
        cs: 'Opravit propojení katalogu se skladem',
        en: 'Correct a catalog to stock binding',
      },
    },
    'correct-external-stock-correlation': {
      title: {
        cs: 'Opravit propojení s externí skladovou položkou',
        en: 'Correct an external stock correlation',
      },
    },
    'correct-stock-position': {
      title: {
        cs: 'Opravit skladovou pozici',
        en: 'Correct a stock position',
      },
    },
    'create-inventory-reservation': {
      title: {
        cs: 'Vytvořit skladovou rezervaci',
        en: 'Create an inventory reservation',
      },
    },
    'end-catalog-to-stock-binding': {
      destructive: true,
      title: {
        cs: 'Ukončit propojení katalogu se skladem',
        en: 'End a catalog to stock binding',
      },
    },
    'end-external-stock-correlation': {
      destructive: true,
      title: {
        cs: 'Ukončit propojení s externí skladovou položkou',
        en: 'End an external stock correlation',
      },
    },
    'end-stock-sharing-eligibility': {
      destructive: true,
      title: {
        cs: 'Ukončit sdílení zásob',
        en: 'End stock sharing eligibility',
      },
    },
    'establish-catalog-to-stock-binding': {
      title: {
        cs: 'Propojit katalogovou položku se skladem',
        en: 'Establish a catalog to stock binding',
      },
    },
    'establish-commitment-protection': 'hidden',
    'establish-external-stock-correlation': {
      title: {
        cs: 'Propojit položku s externím skladem',
        en: 'Establish an external stock correlation',
      },
    },
    'establish-stock-sharing-eligibility': {
      title: {
        cs: 'Povolit sdílení zásob',
        en: 'Establish stock sharing eligibility',
      },
    },
    'import-source-assertion': {
      title: {
        cs: 'Importovat údaje ze zdroje skladových zásob',
        en: 'Import an inventory source assertion',
      },
    },
    'recover-inventory-effect': 'hidden',
    'release-inventory-reservation': {
      title: {
        cs: 'Uvolnit skladovou rezervaci',
        en: 'Release an inventory reservation',
      },
    },
    'resolve-inventory-source-conflict': {
      title: {
        cs: 'Vyřešit konflikt zdrojů skladových dat',
        en: 'Resolve an inventory source conflict',
      },
    },
    'select-inventory-backend': {
      title: {
        cs: 'Vybrat zdroj skladových dat',
        en: 'Select an inventory backend',
      },
    },
    'stock-issue': {
      title: {
        cs: 'Vydat zboží ze skladu',
        en: 'Issue stock',
      },
    },
    'stock-receipt': {
      title: {
        cs: 'Přijmout zboží na sklad',
        en: 'Receive stock',
      },
    },
  },
  approvals: false,
  description: {
    cs: 'Skladové pozice, příjem a výdej, rezervace, propojení s katalogem a správa zdrojů zásob.',
    en: 'Stock positions, receipts and issues, reservations, catalog bindings and inventory source administration.',
  },
  keywords:
    'sklad zásoby příjem výdej rezervace inventura zdroj sdílení zboží inventory stock receipt issue reservation reconciliation',
  label: {
    cs: 'Skladové zásoby',
    en: 'Inventory',
  },
  reads: {
    'catalog-to-stock-binding-resolution': 'hidden',
    'commitment-protection-verification': 'hidden',
    'current-relevant-stock-position-set': {
      title: {
        cs: 'Aktuální skladové pozice',
        en: 'Current stock positions',
      },
    },
    'current-stock-evidence-for-availability': 'hidden',
    'inventory-backend-configuration-current': {
      title: {
        cs: 'Aktuální nastavení zdroje skladových dat',
        en: 'Current inventory backend configuration',
      },
    },
    'inventory-effect-outcome': 'hidden',
    'inventory-reconciliation-evidence': {
      title: {
        cs: 'Podklady pro odsouhlasení skladových zásob',
        en: 'Inventory reconciliation evidence',
      },
    },
    'inventory-reservation-detail': {
      title: {
        cs: 'Detail skladové rezervace',
        en: 'Inventory reservation details',
      },
    },
    'inventory-source-conflict-detail': {
      title: {
        cs: 'Detail konfliktu zdrojů skladových dat',
        en: 'Inventory source conflict details',
      },
    },
    'reservation-confirmation-verification': 'hidden',
    'stock-sharing-eligibility-resolution': 'hidden',
  },
});
