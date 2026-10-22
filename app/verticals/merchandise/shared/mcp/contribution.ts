/** Catalog, stock and order tools offered to agents, without approval plumbing or demo maintenance. */
import { defineOntosMcpContribution } from '@app/core-runtime';

export const merchandiseMcpContribution = defineOntosMcpContribution({
  approvals: true,
  ownProposalEngine: true,
  commands: {
    AiDecideChanges: 'hidden',
    AiProposeChanges: 'hidden',
    AiRevertBatch: 'hidden',
    ArchiveDemoProduct: 'hidden',
    BulkUpdateProducts: {
      agentProposalOnly: true,
      liveRight: 'canManageCatalog',
      title: { cs: 'Hromadně upravit produkty', en: 'Update products in bulk' },
    },
    ChangeOrderStatus: { title: { cs: 'Změnit stav objednávky', en: 'Change an order status' } },
    ChangePrice: {
      agentProposalOnly: true,
      liveRight: 'canManageCatalog',
      title: { cs: 'Změnit cenu', en: 'Change a price' },
    },
    CreateOrder: { title: { cs: 'Vytvořit objednávku', en: 'Create an order' } },
    CreateProduct: {
      liveRight: 'canManageCatalog',
      title: { cs: 'Vytvořit produkt', en: 'Create a product' },
    },
    EditOrder: {
      agentProposalOnly: true,
      liveRight: 'canEditOrders',
      title: { cs: 'Upravit objednávku', en: 'Edit an order' },
    },
    PlaceStorefrontOrder: { title: { cs: 'Přijmout objednávku z e-shopu', en: 'Accept a storefront order' } },
    RecordStockMovement: { title: { cs: 'Zaznamenat skladový pohyb', en: 'Record a stock movement' } },
    RemoveDemoOrder: 'hidden',
    ResetDemoData: 'hidden',
    UpdateCategory: {
      agentProposalOnly: true,
      liveRight: 'canManageCatalog',
      title: { cs: 'Upravit kategorii', en: 'Update a category' },
    },
    UpdateProduct: {
      liveRight: 'canManageCatalog',
      title: { cs: 'Upravit produkt', en: 'Update a product' },
    },
  },
  description: {
    cs: 'Produkty, kategorie, ceny, skladové pohyby a objednávky e-shopu.',
    en: 'Storefront products, categories, prices, stock movements and orders.',
  },
  keywords:
    'produkt zboží katalog cena ceník kategorie sklad zásoby objednávka expedice e-shop product price stock order catalog category storefront',
  label: { cs: 'E-shop – katalog, sklad a objednávky', en: 'E-commerce – catalog, stock and orders' },
  page: '/prodej/objednavky',
  reads: {
    records: { title: { cs: 'Přehled produktů, skladu a objednávek', en: 'Products, stock and orders overview' } },
  },
  revision: { query: { view: {} }, read: 'records' },
});
