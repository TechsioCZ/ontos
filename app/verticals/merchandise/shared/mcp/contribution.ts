/** Catalog, stock and order tools offered to agents, without approval plumbing or demo maintenance. */
import { OntosMcpHidden, defineOntosMcpContribution } from '@app/core-runtime';

export const merchandiseMcpContribution = defineOntosMcpContribution({
  approvalReview: { read: 'agent-review' },
  approvals: true,
  approvalsPage: { label: { cs: 'Otevřít v Prodeji', en: 'Open in Sales' }, path: '/prodej/schvalovani-ai' },
  commandFieldLabels: {
    category: 'Kategorie',
    description: 'Popis',
    lines: 'Položky',
    name: 'Název',
    note: 'Poznámka',
    partyId: 'Zákazník',
    priceMinor: 'Cena bez DPH',
    reason: 'Důvod',
    status: 'Stav',
  },
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
    ChangeProductImages: 'hidden',
    ConfigureMarket: {
      agentProposalOnly: true,
      description: {
        cs: 'Nastaví sortiment a ceník trhu (marketId z commerce.market-catalog): režim WHOLE_CATALOGUE (vše kromě výjimek) nebo SELECTED_PRODUCTS (jen vybrané), měna CZK/EUR/PLN, kurz jako desetinný text (cena s DPH v Kč × kurz) a zaokrouhlení v haléřích/centech. expectedRevision je revize trhu (0 = nový trh).',
        en: 'Sets a market offer and price list (marketId from commerce.market-catalog): mode WHOLE_CATALOGUE (all but exceptions) or SELECTED_PRODUCTS (only selected), currency CZK/EUR/PLN, exchange rate as a decimal string (gross CZK × rate) and rounding in minor units. expectedRevision is the market revision (0 = new market).',
      },
      liveRight: 'canManageCatalog',
      title: { cs: 'Nastavit sortiment a ceník trhu', en: 'Configure a market offer and price list' },
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
    LinkOrderCustomer: 'hidden',
    PlaceStorefrontOrder: { title: { cs: 'Přijmout objednávku z e-shopu', en: 'Accept a storefront order' } },
    RecordStockMovement: { title: { cs: 'Zaznamenat skladový pohyb', en: 'Record a stock movement' } },
    RemoveDemoOrder: 'hidden',
    RemoveMarket: {
      agentProposalOnly: true,
      description: {
        cs: 'Smaže nastavení sortimentu a ceníku trhu včetně všech výjimek produktů; v trhu pak nic není v nabídce.',
        en: 'Deletes a market offer and price list including every product exception; the market then offers nothing.',
      },
      destructive: true,
      liveRight: 'canManageCatalog',
      title: { cs: 'Odebrat sortiment a ceník trhu', en: 'Remove a market offer and price list' },
    },
    ResetDemoData: 'hidden',
    SetMarketProductOffers: {
      agentProposalOnly: true,
      description: {
        cs: 'Zařadí (offered true) nebo vyřadí (false) až 250 produktů v jednom trhu. Výjimka se ukládá jen tam, kde se liší od režimu trhu.',
        en: 'Offers (offered true) or withdraws (false) up to 250 products in one market. An exception is stored only where it differs from the market mode.',
      },
      liveRight: 'canManageCatalog',
      title: { cs: 'Hromadně změnit nabídku produktů v trhu', en: 'Change product offers in a market in bulk' },
    },
    SetProductMarketOffer: {
      description: {
        cs: 'Zařadí (offered true) nebo vyřadí (false) jeden produkt v trhu.',
        en: 'Offers (offered true) or withdraws (false) one product in a market.',
      },
      liveRight: 'canManageCatalog',
      title: { cs: 'Změnit nabídku produktu v trhu', en: 'Change a product offer in a market' },
    },
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
    'produkt zboží katalog cena ceník kategorie sklad zásoby objednávka expedice e-shop trh trhy sortiment měna kurz product price stock order catalog category storefront market currency assortment',
  label: { cs: 'E-shop – katalog, sklad a objednávky', en: 'E-commerce – catalog, stock and orders' },
  ownProposalEngine: true,
  page: '/prodej/objednavky',
  reads: {
    'agent-review': OntosMcpHidden,
    records: {
      description: {
        cs: 'Produkty, sklad a objednávky. view.markets: true vrátí trhy s režimem, měnou, kurzem a počty výjimek; view.marketExceptions { marketId } výjimky produktů trhu; detail produktu (view.productId) vrátí productMarkets s nabídkou a cenou v každém trhu.',
        en: 'Products, stock and orders. view.markets: true returns markets with mode, currency, rate and exception counts; view.marketExceptions { marketId } a market product exceptions; a product detail (view.productId) returns productMarkets with offer and price per market.',
      },
      title: { cs: 'Přehled produktů, skladu a objednávek', en: 'Products, stock and orders overview' },
    },
  },
  revision: { query: { view: { limit: 0, ordersLimit: 0 } }, read: 'records' },
});
