/// <reference types="node" />
/* oxlint-disable effect-native/no-literal-union-type-alias, effect-native/no-throw-in-scripts, eslint/no-nested-ternary -- Plain sales-demo fixture data shared by seed scripts; not product code. expires: 2027-03-31. */
/**
 * Single source of truth for the cross-module sales-demo dataset. The sales-pipeline, merchandise and
 * siampark-billing-finance seeds all derive their rows from this plan, so WON opportunities, their orders
 * and their invoices always agree (same customers, products, quantities and snapshot prices).
 *
 * Keys: products p01…p25, opportunities o01…o60, orders r01…r40, invoices i01…i30, customers c01…c40,
 * employees by workforce key. Resolve IDs with `demoId(namespace, key)` from `./fixture-ids.mts`.
 */

export type VatRate = 0 | 10 | 12 | 21;
export type OpportunityStage = 'LEAD' | 'QUALIFIED' | 'PROPOSAL' | 'NEGOTIATION' | 'WON' | 'LOST';

export interface CatalogProduct {
  readonly category: string;
  /** Current price; differs from the original for p01, p05 and p09 (raised two weeks ago). */
  readonly currentPriceMinor: number;
  readonly key: string;
  readonly lowStockThreshold: number;
  readonly name: string;
  readonly openingStock: number;
  /** Price before the demo's recent price change (used for all historical snapshots). */
  readonly originalPriceMinor: number;
  readonly sku: string;
  readonly unit: 'ks' | 'bal' | 'hod' | 'lic';
  readonly vatRate: VatRate;
}

const NOTEBOOKS = 'Notebooky';
const MONITORS = 'Monitory';
const ACCESSORIES = 'Příslušenství';
const SERVERS = 'Servery';
const NETWORKING = 'Síťové prvky';
const SOFTWARE = 'Software';
const SERVICES = 'Služby';
const PRINTING = 'Tisk';

const czk = (amount: number): number => amount * 100;

export const catalog: readonly CatalogProduct[] = [
  {
    category: NOTEBOOKS,
    currentPriceMinor: czk(34_990),
    key: 'p01',
    lowStockThreshold: 8,
    name: 'Notebook Pro 14"',
    openingStock: 40,
    originalPriceMinor: czk(32_990),
    sku: 'NB-PRO-14',
    unit: 'ks',
    vatRate: 21,
  },
  {
    category: NOTEBOOKS,
    currentPriceMinor: czk(24_990),
    key: 'p02',
    lowStockThreshold: 10,
    name: 'Notebook Air 13"',
    openingStock: 55,
    originalPriceMinor: czk(24_990),
    sku: 'NB-AIR-13',
    unit: 'ks',
    vatRate: 21,
  },
  {
    category: MONITORS,
    currentPriceMinor: czk(9490),
    key: 'p03',
    lowStockThreshold: 12,
    name: 'Monitor 27" 4K',
    openingStock: 70,
    originalPriceMinor: czk(9490),
    sku: 'MON-27-4K',
    unit: 'ks',
    vatRate: 21,
  },
  {
    category: MONITORS,
    currentPriceMinor: czk(14_990),
    key: 'p04',
    lowStockThreshold: 6,
    name: 'Monitor 34" ultrawide',
    openingStock: 25,
    originalPriceMinor: czk(14_990),
    sku: 'MON-34-UW',
    unit: 'ks',
    vatRate: 21,
  },
  {
    category: ACCESSORIES,
    currentPriceMinor: czk(4690),
    key: 'p05',
    lowStockThreshold: 20,
    name: 'Dokovací stanice USB-C',
    openingStock: 120,
    originalPriceMinor: czk(4290),
    sku: 'DOCK-USB-C',
    unit: 'ks',
    vatRate: 21,
  },
  {
    category: ACCESSORIES,
    currentPriceMinor: czk(1290),
    key: 'p06',
    lowStockThreshold: 30,
    name: 'Bezdrátová klávesnice CZ',
    openingStock: 200,
    originalPriceMinor: czk(1290),
    sku: 'KB-WL-CZ',
    unit: 'ks',
    vatRate: 21,
  },
  {
    category: ACCESSORIES,
    currentPriceMinor: czk(990),
    key: 'p07',
    lowStockThreshold: 30,
    name: 'Ergonomická myš',
    openingStock: 220,
    originalPriceMinor: czk(990),
    sku: 'MS-ERGO',
    unit: 'ks',
    vatRate: 21,
  },
  {
    category: ACCESSORIES,
    currentPriceMinor: czk(3490),
    key: 'p08',
    lowStockThreshold: 15,
    name: 'Headset s ANC',
    openingStock: 90,
    originalPriceMinor: czk(3490),
    sku: 'HS-ANC',
    unit: 'ks',
    vatRate: 21,
  },
  {
    category: SERVERS,
    currentPriceMinor: czk(94_900),
    key: 'p09',
    lowStockThreshold: 3,
    name: 'Server rack 1U',
    openingStock: 12,
    originalPriceMinor: czk(89_900),
    sku: 'SRV-RACK-1U',
    unit: 'ks',
    vatRate: 21,
  },
  {
    category: SERVERS,
    currentPriceMinor: czk(18_990),
    key: 'p10',
    lowStockThreshold: 4,
    name: 'NAS úložiště 4 disky',
    openingStock: 18,
    originalPriceMinor: czk(18_990),
    sku: 'NAS-4BAY',
    unit: 'ks',
    vatRate: 21,
  },
  {
    category: NETWORKING,
    currentPriceMinor: czk(12_490),
    key: 'p11',
    lowStockThreshold: 6,
    name: 'Switch 24 portů PoE',
    openingStock: 30,
    originalPriceMinor: czk(12_490),
    sku: 'SW-24P-POE',
    unit: 'ks',
    vatRate: 21,
  },
  {
    category: NETWORKING,
    currentPriceMinor: czk(5990),
    key: 'p12',
    lowStockThreshold: 10,
    name: 'Access point Wi-Fi 7',
    openingStock: 60,
    originalPriceMinor: czk(5990),
    sku: 'AP-WIFI7',
    unit: 'ks',
    vatRate: 21,
  },
  {
    category: NETWORKING,
    currentPriceMinor: czk(21_990),
    key: 'p13',
    lowStockThreshold: 3,
    name: 'Firewall pro malé firmy',
    openingStock: 14,
    originalPriceMinor: czk(21_990),
    sku: 'FW-SMB',
    unit: 'ks',
    vatRate: 21,
  },
  {
    category: SOFTWARE,
    currentPriceMinor: czk(2890),
    key: 'p14',
    lowStockThreshold: 50,
    name: 'Kancelářský balík – roční licence',
    openingStock: 1000,
    originalPriceMinor: czk(2890),
    sku: 'LIC-OFFICE',
    unit: 'lic',
    vatRate: 21,
  },
  {
    category: SOFTWARE,
    currentPriceMinor: czk(790),
    key: 'p15',
    lowStockThreshold: 50,
    name: 'Antivirus Business – roční licence',
    openingStock: 1000,
    originalPriceMinor: czk(790),
    sku: 'LIC-AV',
    unit: 'lic',
    vatRate: 21,
  },
  {
    category: SOFTWARE,
    currentPriceMinor: czk(4990),
    key: 'p16',
    lowStockThreshold: 25,
    name: 'Zálohování do cloudu – roční licence',
    openingStock: 500,
    originalPriceMinor: czk(4990),
    sku: 'LIC-BACKUP',
    unit: 'lic',
    vatRate: 21,
  },
  {
    category: SERVICES,
    currentPriceMinor: czk(1490),
    key: 'p17',
    lowStockThreshold: 0,
    name: 'Instalace a konfigurace',
    openingStock: 2000,
    originalPriceMinor: czk(1490),
    sku: 'SVC-INSTALL',
    unit: 'hod',
    vatRate: 21,
  },
  {
    category: 'Tablety',
    currentPriceMinor: czk(7990),
    key: 'p18',
    lowStockThreshold: 6,
    name: 'Tablet 10"',
    openingStock: 35,
    originalPriceMinor: czk(8990),
    sku: 'TAB-10',
    unit: 'ks',
    vatRate: 21,
  },
  {
    category: PRINTING,
    currentPriceMinor: czk(5490),
    key: 'p19',
    lowStockThreshold: 5,
    name: 'Laserová tiskárna A4',
    openingStock: 22,
    originalPriceMinor: czk(6490),
    sku: 'PRN-LASER',
    unit: 'ks',
    vatRate: 21,
  },
  {
    category: PRINTING,
    currentPriceMinor: czk(1590),
    key: 'p20',
    lowStockThreshold: 25,
    name: 'Toner černý',
    openingStock: 140,
    originalPriceMinor: czk(1890),
    sku: 'TONER-BK',
    unit: 'ks',
    vatRate: 21,
  },
  {
    category: PRINTING,
    currentPriceMinor: czk(490),
    key: 'p21',
    lowStockThreshold: 60,
    name: 'Papír A4 80 g (5 balíků)',
    openingStock: 300,
    originalPriceMinor: czk(590),
    sku: 'PAPER-A4',
    unit: 'bal',
    vatRate: 21,
  },
  {
    category: SERVERS,
    currentPriceMinor: czk(7990),
    key: 'p22',
    lowStockThreshold: 5,
    name: 'UPS 1500 VA',
    openingStock: 4,
    originalPriceMinor: czk(7990),
    sku: 'UPS-1500',
    unit: 'ks',
    vatRate: 21,
  },
  {
    category: ACCESSORIES,
    currentPriceMinor: czk(11_990),
    key: 'p23',
    lowStockThreshold: 4,
    name: 'Konferenční kamera',
    openingStock: 16,
    originalPriceMinor: czk(11_990),
    sku: 'CAM-CONF',
    unit: 'ks',
    vatRate: 21,
  },
  {
    category: SERVICES,
    currentPriceMinor: czk(4900),
    key: 'p24',
    lowStockThreshold: 0,
    name: 'Servisní podpora – měsíc',
    openingStock: 2000,
    originalPriceMinor: czk(4900),
    sku: 'SVC-SUPPORT',
    unit: 'hod',
    vatRate: 21,
  },
  {
    category: 'Literatura',
    currentPriceMinor: czk(490),
    key: 'p25',
    lowStockThreshold: 10,
    name: 'Příručka IT bezpečnosti',
    openingStock: 80,
    originalPriceMinor: czk(490),
    sku: 'BOOK-IT',
    unit: 'ks',
    vatRate: 10,
  },
];

/** Deterministic PRNG (Park–Miller) so every cold reset yields identical data. */
const prng = (seed: number) => {
  let state = (seed % 2_147_483_646) + 1;
  return (): number => {
    state = (state * 48_271) % 2_147_483_647;
    return (state - 1) / 2_147_483_646;
  };
};

const pad2 = (value: number): string => String(value).padStart(2, '0');

/** Sales owners (workforce keys). `null` = unassigned opportunity. */
export const salesOwnerKeys = [
  'obchod',
  'obchodnik',
  'lucie-dvorakova',
  'tomas-cerny',
  'katerina-prochazkova',
  'martin-kucera',
] as const;

const opportunityTitles = [
  'Obnova notebooků pro obchodní tým',
  'Vybavení nové pobočky',
  'Síťová infrastruktura – modernizace',
  'Licence kancelářského balíku',
  'Serverovna – rozšíření kapacity',
  'Videokonference do zasedaček',
  'Tiskové služby na rok',
  'Zálohování a bezpečnost dat',
  'Home office balíčky',
  'Wi-Fi pokrytí skladu',
  'Monitory pro vývojáře',
  'Servisní smlouva na podporu',
];

export interface PlannedLine {
  readonly productKey: string;
  readonly quantity: number;
}

export interface PlannedOpportunity {
  /** Days before the reference date it was closed (WON/LOST only). */
  readonly closedDaysAgo: number | null;
  /** Days before the reference date the opportunity was created. */
  readonly createdDaysAgo: number;
  readonly customerKey: string;
  readonly expectedCloseInDays: number;
  readonly key: string;
  readonly lines: readonly PlannedLine[];
  readonly ownerKey: string | null;
  readonly stage: OpportunityStage;
  readonly title: string;
}

const stageForIndex = (index: number): OpportunityStage => {
  if (index < 18) {
    return 'WON';
  }
  if (index < 26) {
    return 'LOST';
  }
  const open: readonly OpportunityStage[] = ['LEAD', 'QUALIFIED', 'PROPOSAL', 'NEGOTIATION'];
  return open[(index - 26) % open.length] ?? 'LEAD';
};

/** o01…o18 WON (closed over the last 12 months), o19…o26 LOST, o27…o60 open across the four open stages. */
export const opportunities: readonly PlannedOpportunity[] = Array.from({ length: 60 }, (_slot1, index) => {
  const random = prng(1000 + index);
  const stage = stageForIndex(index);
  const closed = stage === 'WON' || stage === 'LOST';
  const closedDaysAgo = closed ? Math.round(5 + (index % 18) * 19 + random() * 10) : null;
  const lineCount = 1 + Math.floor(random() * 3);
  const lines = Array.from({ length: lineCount }, (_slot2, lineIndex) => {
    const product = catalog[Math.floor(random() * catalog.length)] ?? catalog[0];
    const bulk = product?.unit === 'lic' || product?.unit === 'hod';
    return {
      productKey: product?.key ?? 'p01',
      quantity: bulk ? 10 + Math.floor(random() * 40) : 1 + Math.floor(random() * 12) + lineIndex,
    };
  });
  const ownerIndex = Math.floor(random() * (salesOwnerKeys.length + 1));
  return {
    closedDaysAgo,
    createdDaysAgo: (closedDaysAgo ?? 0) + 14 + Math.floor(random() * 40),
    customerKey: `c${pad2((index % 40) + 1)}`,
    expectedCloseInDays: closed ? 0 : 7 + Math.floor(random() * 75),
    key: `o${pad2(index + 1)}`,
    lines,
    ownerKey: index % 9 === 4 ? null : (salesOwnerKeys[ownerIndex % salesOwnerKeys.length] ?? null),
    stage,
    title: opportunityTitles[index % opportunityTitles.length] ?? 'Zakázka',
  };
});

export const productByKey = (key: string): CatalogProduct => {
  const product = catalog.find((candidate) => candidate.key === key);
  if (product === undefined) {
    throw new Error(`Unknown demo product ${key}`);
  }
  return product;
};

/**
 * Snapshot unit price used by historical documents. Everything closed before the recent price change
 * (more than 14 days ago) uses the original price; this is what makes requirement 7d visible.
 */
export const snapshotPriceMinor = (productKey: string, daysAgo: number): number => {
  const product = productByKey(productKey);
  return daysAgo > 14 ? product.originalPriceMinor : product.currentPriceMinor;
};

/** Days ago of the recent price change for p01, p05, p09, p18–p21. */
export const priceChangeDaysAgo = 14;

export interface PlannedInvoice {
  readonly customerKey: string;
  readonly issueDaysAgo: number;
  readonly key: string;
  readonly lines: readonly PlannedLine[];
  readonly opportunityKey: string | null;
  readonly payment: 'PAID' | 'PARTIALLY_PAID' | 'UNPAID';
  readonly state: 'CONFIRMED' | 'DRAFT';
}

const wonOpportunities = opportunities.filter((opportunity) => opportunity.stage === 'WON');

/** i01…i18 from WON opportunities (same lines, issued on close), i19…i30 standalone invoices. */
export const invoices: readonly PlannedInvoice[] = [
  ...wonOpportunities.map((opportunity, index) => ({
    customerKey: opportunity.customerKey,
    issueDaysAgo: opportunity.closedDaysAgo ?? 0,
    key: `i${pad2(index + 1)}`,
    lines: opportunity.lines,
    opportunityKey: opportunity.key,
    payment: index < 12 ? ('PAID' as const) : index < 15 ? ('PARTIALLY_PAID' as const) : ('UNPAID' as const),
    state: 'CONFIRMED' as const,
  })),
  ...Array.from({ length: 12 }, (_slot3, index) => {
    const random = prng(5000 + index);
    const product = catalog[Math.floor(random() * catalog.length)] ?? catalog[0];
    return {
      customerKey: `c${pad2(((index * 7) % 40) + 1)}`,
      issueDaysAgo: 10 + index * 28,
      key: `i${pad2(19 + index)}`,
      lines: [{ productKey: product?.key ?? 'p01', quantity: 1 + Math.floor(random() * 6) }],
      opportunityKey: null,
      payment: index % 4 === 0 ? ('UNPAID' as const) : ('PAID' as const),
      state: index === 0 ? ('DRAFT' as const) : ('CONFIRMED' as const),
    };
  }),
];

export interface PlannedOrder {
  readonly createdDaysAgo: number;
  readonly customerKey: string;
  readonly key: string;
  readonly lines: readonly PlannedLine[];
  readonly opportunityKey: string | null;
  readonly status: 'NEW' | 'CONFIRMED' | 'SHIPPED' | 'DELIVERED' | 'CANCELLED';
}

/** r01…r18 fulfil WON opportunities, r19…r40 standalone orders. */
export const orders: readonly PlannedOrder[] = [
  ...wonOpportunities.map((opportunity, index) => ({
    createdDaysAgo: Math.max(0, (opportunity.closedDaysAgo ?? 0) - 1),
    customerKey: opportunity.customerKey,
    key: `r${pad2(index + 1)}`,
    lines: opportunity.lines,
    opportunityKey: opportunity.key,
    status: index < 14 ? ('DELIVERED' as const) : index < 16 ? ('SHIPPED' as const) : ('CONFIRMED' as const),
  })),
  ...Array.from({ length: 22 }, (_slot4, index) => {
    const random = prng(9000 + index);
    const product = catalog[Math.floor(random() * catalog.length)] ?? catalog[0];
    const statuses = ['DELIVERED', 'DELIVERED', 'SHIPPED', 'CONFIRMED', 'NEW', 'CANCELLED'] as const;
    return {
      createdDaysAgo: 3 + index * 15,
      customerKey: `c${pad2(((index * 11) % 40) + 1)}`,
      key: `r${pad2(19 + index)}`,
      lines: [{ productKey: product?.key ?? 'p02', quantity: 1 + Math.floor(random() * 5) }],
      opportunityKey: null,
      status: statuses[index % statuses.length] ?? 'NEW',
    };
  }),
];

/** Units of a product consumed by non-cancelled planned orders. */
export const plannedSoldQuantity = (productKey: string): number =>
  orders
    .filter((order) => order.status !== 'CANCELLED')
    .flatMap((order) => order.lines)
    .filter((line) => line.productKey === productKey)
    .reduce((sum, line) => sum + line.quantity, 0);

/**
 * Opening RECEIPT quantity seeded ~13 months ago: planned orders then issue stock, leaving exactly
 * `openingStock` on hand today (UPS-1500 deliberately ends below its threshold).
 */
export const openingReceiptQuantity = (productKey: string): number =>
  productByKey(productKey).openingStock + plannedSoldQuantity(productKey);
