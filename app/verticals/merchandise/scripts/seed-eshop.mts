/**
 * E-shop demo seed (`pnpm demo:seed:eshop`) for the Kavárna Doma s.r.o. company
 * (legal entity 71000000-0000-4000-8000-000000000023). Writes only that company's merchandise aggregate; the
 * Obchodní firma aggregate is never read or written.
 *
 * Default mode merges: seed products, variants, stock receipts and sample orders are added when missing (by
 * id), everything created or edited during a demo is kept, so running it twice changes nothing.
 * `--reset` replaces the company aggregate with the pristine seed (predictable starting state, E01-02).
 * `--restore-catalog` puts seed products back to their seed prices/variants/images but keeps every order.
 * `--validate-only` builds and schema-checks the state without touching the database.
 */
import { NodeRuntime, NodeServices } from '@effect/platform-node';
import { PgClient } from '@effect/sql-pg';
import { Command, Flag } from 'effect/cli';
import { Config, ConfigProvider, Console, DateTime, Effect, Layer, Schema } from 'effect';
import { Reactivity } from 'effect/reactivity';
import { demoId, demoTenantId } from '../../../scripts/demo/fixture-ids.mts';
import { MerchandiseStateSchema } from '../shared/apis/records.ts';
import type { MerchandiseState } from '../shared/apis/records.ts';
import { grossUnitPriceMinor, shippingMethods } from '../shared/domain/merchandise-model.ts';
import type { OrderStatus, ShippingMethod } from '../shared/domain/merchandise-model.ts';
import { fullOrderTotals, ORDER_NUMBER_PREFIX } from '../shared/domain/order-totals.ts';
import { readCompanySnapshot, writeCompanySnapshot } from './company-snapshot.ts';

export const eshopLegalEntityId = '71000000-0000-4000-8000-000000000023' as const;

type Encoded = typeof MerchandiseStateSchema.Encoded;
type EncodedProduct = Encoded['products'][number];
type EncodedMovement = Encoded['movements'][number];
type EncodedOrder = Encoded['orders'][number];
type SeedProductState = { -readonly [K in keyof EncodedProduct]: EncodedProduct[K] };
type SeedOrderLine = { -readonly [K in keyof EncodedOrder['lines'][number]]: EncodedOrder['lines'][number][K] };
type SeedOrderHistory = {
  -readonly [K in keyof NonNullable<EncodedOrder['history']>[number]]: NonNullable<EncodedOrder['history']>[number][K];
};
type SeedOrderState = { -readonly [K in keyof EncodedOrder]: EncodedOrder[K] };

class SeedProductMissing extends Schema.TaggedError<SeedProductMissing>()('SeedProductMissing', {
  slug: Schema.String,
}) {}

const SEED_INSTANT = DateTime.makeUnsafe('2026-10-19T08:00:00Z');
const daysAgo = (days: number, hours = 0): string =>
  DateTime.formatIso(DateTime.subtract(SEED_INSTANT, { days, hours }));

const productIdOf = (slug: string) => demoId('eshop.product', slug);
const variantIdOf = (slug: string, key: string) => `${slug}--${key}`;
const eshopAdmin = { principalId: demoId('core.principal', 'kavarna-eshop'), tenantId: demoTenantId };
const eshopDispatch = { principalId: demoId('core.principal', 'kavarna-expedice'), tenantId: demoTenantId };

/** Net minor price whose server-computed gross equals `grossMinor` (closest one when not exactly reachable). */
export const netForGross = (grossMinor: number, vatRate: number): number => {
  const estimate = Math.round((grossMinor * 100) / (100 + vatRate));
  let best = estimate;
  for (let candidate = estimate - 3; candidate <= estimate + 3; candidate += 1) {
    if (
      Math.abs(grossUnitPriceMinor(candidate, vatRate) - grossMinor) <
      Math.abs(grossUnitPriceMinor(best, vatRate) - grossMinor)
    ) {
      best = candidate;
    }
  }
  return best;
};

interface SeedVariant {
  readonly attributes: string;
  readonly gross: number;
  readonly key: string;
  readonly name: string;
  /** Opening stock; 0 means sold out. */
  readonly stock: number;
}

interface SeedProduct {
  readonly category: string;
  readonly description: string;
  /** Gross CZK (whole crowns) for products without variants. */
  readonly gross?: number;
  readonly images?: readonly string[];
  readonly lowStockThreshold: number;
  readonly name: string;
  readonly published?: boolean;
  readonly shortDescription: string;
  readonly sku: string;
  readonly slug: string;
  readonly stock?: number;
  readonly stockTracked?: boolean;
  readonly variants?: readonly SeedVariant[];
  readonly vatRate: 12 | 21;
  readonly weightGrams?: number;
}

const ZRNKOVA = 'Zrnková káva';
const MLETA = 'Mletá káva';
const CAJ = 'Čaj';
const PRIPRAVA = 'Příprava kávy';
const DARKY = 'Dárkové balíčky';
const ESPRESSO_GRIND = 'Hmotnost: 250 g; Mletí: jemné';
const FILTER_GRIND = 'Hmotnost: 250 g; Mletí: střední';
const FILTER_VARIANT_NAME = '250 g / mletá na filtr';
const ESPRESSO_VARIANT_NAME = '250 g / mletá na espresso';
const FIFTY_GRAM_ATTRIBUTES = 'Hmotnost: 50 g';
const HUNDRED_GRAM_ATTRIBUTES = 'Hmotnost: 100 g';

const beans = (prices: readonly [number, number, number?], stock: readonly [number, number, number?]) => {
  const variants: SeedVariant[] = [
    {
      attributes: 'Hmotnost: 250 g; Forma: zrnková',
      gross: prices[0],
      key: '250g',
      name: '250 g / zrnková',
      stock: stock[0],
    },
  ];
  if (prices[2] !== undefined) {
    variants.push({
      attributes: 'Hmotnost: 500 g; Forma: zrnková',
      gross: prices[2],
      key: '500g',
      name: '500 g / zrnková',
      stock: stock[2] ?? 0,
    });
  }
  variants.push({
    attributes: 'Hmotnost: 1 kg; Forma: zrnková',
    gross: prices[1],
    key: '1kg',
    name: '1 kg / zrnková',
    stock: stock[1],
  });
  return variants;
};

export const eshopCatalog: readonly SeedProduct[] = [
  {
    category: ZRNKOVA,
    description:
      'Výběrová káva z oblasti Yirgacheffe v jižní Etiopii, zpracovaná promýváním. V šálku jasmín, bergamot a meruňka s čistou citrusovou kyselostí. Pražíme světle, ideální na filtr, V60 i AeroPress.',
    lowStockThreshold: 5,
    name: 'Etiopie Yirgacheffe Konga',
    shortDescription: 'Květinová a citrusová, světlé pražení na filtr.',
    sku: 'KD-ETH-YIR',
    slug: 'etiopie-yirgacheffe',
    variants: beans([28_900, 98_900, 52_900], [42, 9, 18]),
    vatRate: 12,
  },
  {
    category: ZRNKOVA,
    description:
      'Kolumbijská klasika z departementu Huila. Mléčná čokoláda, karamel a červené jablko. Středně pražená, univerzální pro espresso i překapávanou kávu.',
    lowStockThreshold: 5,
    name: 'Kolumbie Huila Supremo',
    shortDescription: 'Čokoláda a karamel, univerzální pražení.',
    sku: 'KD-COL-HUI',
    slug: 'kolumbie-huila',
    variants: beans([25_900, 89_900], [55, 14]),
    vatRate: 12,
  },
  {
    category: ZRNKOVA,
    description:
      'Přirozeně zpracovaná káva z náhorní plošiny Cerrado. Nízká kyselost, oříšky a hořká čokoláda. Skvělý základ pro espresso s mlékem.',
    lowStockThreshold: 5,
    name: 'Brazílie Santos Cerrado',
    shortDescription: 'Oříšková, nízká kyselost, do espressa s mlékem.',
    sku: 'KD-BRA-SAN',
    slug: 'brazilie-santos',
    variants: beans([21_900, 75_900], [60, 20]),
    vatRate: 12,
  },
  {
    category: ZRNKOVA,
    description:
      'Keňa AA z oblasti Nyeri, odrůdy SL28 a SL34. Výrazný černý rybíz, grapefruit a šťavnaté tělo. Limitovaná sklizeň — kilogramová balení dochází.',
    lowStockThreshold: 4,
    name: 'Keňa AA Nyeri',
    shortDescription: 'Černý rybíz a grapefruit, limitovaná sklizeň.',
    sku: 'KD-KEN-NYE',
    slug: 'kena-aa-nyeri',
    variants: beans([33_900, 118_900], [12, 3]),
    vatRate: 12,
  },
  {
    category: ZRNKOVA,
    description:
      'Guatemala z vulkanických svahů kolem města Antigua. Kakao, pražené mandle a jemné koření. Nová sklizeň dorazí v listopadu.',
    lowStockThreshold: 5,
    name: 'Guatemala Antigua',
    shortDescription: 'Kakao a mandle — momentálně vyprodáno.',
    sku: 'KD-GUA-ANT',
    slug: 'guatemala-antigua',
    variants: beans([27_900, 95_900], [0, 0]),
    vatRate: 12,
  },
  {
    category: ZRNKOVA,
    description:
      'Naše domácí espresso směs: 70 % Brazílie a 30 % Etiopie Sidamo. Plné tělo, tmavá čokoláda a sušené švestky, hustá crema. Nejprodávanější káva Kavárny Doma.',
    lowStockThreshold: 8,
    name: 'Espresso Domácí směs',
    shortDescription: 'Nejprodávanější směs na espresso, hustá crema.',
    sku: 'KD-ESP-DOM',
    slug: 'espresso-domaci-smes',
    variants: beans([24_900, 84_900, 45_900], [80, 25, 30]),
    vatRate: 12,
  },
  {
    category: ZRNKOVA,
    description:
      'Mikrolot z družstva Nyamasheke ve Rwandě. Dodávky od farmáře přicházejí nepravidelně a sklad neeviduje přesný počet kusů, proto e-shop dostupnost ověřit neumí.',
    gross: 36_900,
    lowStockThreshold: 2,
    name: 'Rwanda Nyamasheke – mikrolot',
    shortDescription: 'Malinová sladkost a čaj z ibišku, 250 g.',
    sku: 'KD-RWA-NYA',
    slug: 'rwanda-nyamasheke',
    stockTracked: false,
    vatRate: 12,
    weightGrams: 250,
  },
  {
    category: MLETA,
    description:
      'Domácí espresso směs čerstvě namletá po upražení. Vyberte hrubost mletí podle přípravy: jemné mletí do pákového kávovaru, střední na filtr nebo do french pressu.',
    lowStockThreshold: 6,
    name: 'Espresso Domácí směs – mletá',
    shortDescription: 'Čerstvě namletá, vyberte hrubost mletí.',
    sku: 'KD-ESP-MLE',
    slug: 'espresso-mleta',
    variants: [
      {
        attributes: ESPRESSO_GRIND,
        gross: 25_900,
        key: 'espresso',
        name: ESPRESSO_VARIANT_NAME,
        stock: 34,
      },
      {
        attributes: FILTER_GRIND,
        gross: 25_900,
        key: 'filtr',
        name: FILTER_VARIANT_NAME,
        stock: 21,
      },
    ],
    vatRate: 12,
  },
  {
    category: MLETA,
    description:
      'Kolumbijská káva bez kofeinu, dekofeinovaná šetrnou metodou Swiss Water. Chutná jako opravdová káva — karamel, kakao a lískové oříšky.',
    lowStockThreshold: 5,
    name: 'Kolumbie Decaf – mletá',
    shortDescription: 'Bez kofeinu metodou Swiss Water.',
    sku: 'KD-DEC-MLE',
    slug: 'kolumbie-decaf-mleta',
    variants: [
      {
        attributes: FILTER_GRIND,
        gross: 27_900,
        key: 'filtr',
        name: FILTER_VARIANT_NAME,
        stock: 16,
      },
      {
        attributes: ESPRESSO_GRIND,
        gross: 27_900,
        key: 'espresso',
        name: ESPRESSO_VARIANT_NAME,
        stock: 4,
      },
    ],
    vatRate: 12,
  },
  {
    category: MLETA,
    description:
      'Brazilská káva namletá extra jemně, téměř na prach — přesně pro přípravu v džezvě. Tradiční turecký styl s plným tělem.',
    gross: 19_900,
    lowStockThreshold: 5,
    name: 'Brazílie – extra jemně mletá (turecká)',
    shortDescription: 'Pro přípravu v džezvě, 250 g.',
    sku: 'KD-TUR-MLE',
    slug: 'brazilie-turecka',
    stock: 27,
    vatRate: 12,
    weightGrams: 250,
  },
  {
    category: MLETA,
    description:
      'Jemná snídaňová směs středoamerických káv, mletá na filtr. Med, mandle a mléčná čokoláda — káva, která potěší každé ráno.',
    lowStockThreshold: 5,
    name: 'Snídaňová směs – mletá',
    shortDescription: 'Jemná ranní káva na filtr.',
    sku: 'KD-SNI-MLE',
    slug: 'snidanova-smes',
    variants: [
      {
        attributes: FILTER_GRIND,
        gross: 22_900,
        key: '250g',
        name: FILTER_VARIANT_NAME,
        stock: 38,
      },
      {
        attributes: 'Hmotnost: 500 g; Mletí: střední',
        gross: 41_900,
        key: '500g',
        name: '500 g / mletá na filtr',
        stock: 0,
      },
    ],
    vatRate: 12,
  },
  {
    category: CAJ,
    description:
      'Zelený čaj z ostrova Kjúšú v prefektuře Kagošima. Svěží, travnatý, s umami a jemnou sladkostí. Louhujte 1 minutu při 70 °C.',
    lowStockThreshold: 5,
    name: 'Japonská Sencha Kagoshima',
    shortDescription: 'Svěží zelený čaj s umami.',
    sku: 'KD-TEA-SEN',
    slug: 'sencha-kagoshima',
    variants: [
      { attributes: FIFTY_GRAM_ATTRIBUTES, gross: 18_900, key: '50g', name: '50 g', stock: 30 },
      { attributes: HUNDRED_GRAM_ATTRIBUTES, gross: 34_900, key: '100g', name: '100 g', stock: 12 },
    ],
    vatRate: 12,
  },
  {
    category: CAJ,
    description:
      'Černý čaj z Assamu a Cejlonu s olejem z bergamotu a sušenou pomerančovou kůrou. Klasika na odpoledne, s mlékem i bez.',
    lowStockThreshold: 5,
    name: 'Earl Grey s pomerančovou kůrou',
    shortDescription: 'Černý čaj s bergamotem a pomerančem.',
    sku: 'KD-TEA-EGR',
    slug: 'earl-grey',
    variants: [
      { attributes: FIFTY_GRAM_ATTRIBUTES, gross: 12_900, key: '50g', name: '50 g', stock: 45 },
      { attributes: HUNDRED_GRAM_ATTRIBUTES, gross: 22_900, key: '100g', name: '100 g', stock: 22 },
    ],
    vatRate: 12,
  },
  {
    category: CAJ,
    description:
      'Jarní sklizeň z čajové zahrady Castleton v Dárdžilingu. Muškátové tóny, květiny a zelené mandle. Sezónní čaj — letošní sklizeň je vyprodaná.',
    lowStockThreshold: 3,
    name: 'Darjeeling First Flush FTGFOP1',
    shortDescription: 'Jarní sklizeň — vyprodáno do příští sezóny.',
    sku: 'KD-TEA-DAR',
    slug: 'darjeeling-first-flush',
    variants: [
      { attributes: FIFTY_GRAM_ATTRIBUTES, gross: 21_900, key: '50g', name: '50 g', stock: 0 },
      { attributes: HUNDRED_GRAM_ATTRIBUTES, gross: 39_900, key: '100g', name: '100 g', stock: 0 },
    ],
    vatRate: 12,
  },
  {
    category: CAJ,
    description: 'Jihoafrický rooibos bez kofeinu s kousky vanilky. Přirozeně nasládlý, vhodný na večer i pro děti.',
    gross: 15_900,
    lowStockThreshold: 6,
    name: 'Rooibos s vanilkou',
    shortDescription: 'Bez kofeinu, přirozeně nasládlý, 100 g.',
    sku: 'KD-TEA-ROO',
    slug: 'rooibos-vanilka',
    stock: 4,
    vatRate: 12,
    weightGrams: 100,
  },
  {
    category: CAJ,
    description:
      'Obřadní matcha z japonského Udži, kamenně mletá z čajových lístků tencha. Sytě zelená, krémová, bez hořkosti. Balení 30 g v plechovce.',
    gross: 44_900,
    lowStockThreshold: 4,
    name: 'Matcha Ceremonial Uji',
    shortDescription: 'Obřadní matcha z Udži, 30 g.',
    sku: 'KD-TEA-MAT',
    slug: 'matcha-uji',
    stock: 3,
    vatRate: 12,
    weightGrams: 30,
  },
  {
    category: PRIPRAVA,
    description:
      'Keramický dripper Hario V60 s typickými spirálovými drážkami a velkým otvorem. Keramika drží teplotu, takže extrakce je stabilní. Velikost 01 na 1–2 šálky, 02 na 1–4 šálky.',
    lowStockThreshold: 3,
    name: 'Hario V60 keramický dripper',
    shortDescription: 'Ikonický dripper na překapávanou kávu.',
    sku: 'KD-HAR-V60',
    slug: 'hario-v60',
    variants: [
      { attributes: 'Velikost: 01; Barva: bílá', gross: 54_900, key: '01-bila', name: 'Velikost 01 / bílá', stock: 11 },
      { attributes: 'Velikost: 02; Barva: bílá', gross: 64_900, key: '02-bila', name: 'Velikost 02 / bílá', stock: 8 },
      {
        attributes: 'Velikost: 02; Barva: černá',
        gross: 64_900,
        key: '02-cerna',
        name: 'Velikost 02 / černá',
        stock: 2,
      },
    ],
    vatRate: 21,
  },
  {
    category: PRIPRAVA,
    description:
      'AeroPress Original — rychlá, čistá a odolná příprava kávy pod tlakem. Za minutu připravíte šálek bez usazenin. Balení obsahuje 350 papírových filtrů.',
    gross: 109_000,
    lowStockThreshold: 3,
    name: 'AeroPress Original',
    shortDescription: 'Káva za minutu, i na cesty.',
    sku: 'KD-AERO',
    slug: 'aeropress',
    stock: 14,
    vatRate: 21,
  },
  {
    category: PRIPRAVA,
    description:
      'Originální italská moka konvička Bialetti z hliníku s osmihrannou siluetou. Silná káva na sporáku jako v Itálii. Vhodná na plyn, elektrický i sklokeramický sporák (ne indukce).',
    lowStockThreshold: 3,
    name: 'Bialetti Moka Express',
    shortDescription: 'Italská moka konvička na sporák.',
    sku: 'KD-BIA-MOK',
    slug: 'bialetti-moka',
    variants: [
      { attributes: 'Objem: 3 šálky', gross: 87_900, key: '3', name: '3 šálky', stock: 9 },
      { attributes: 'Objem: 6 šálků', gross: 119_900, key: '6', name: '6 šálků', stock: 5 },
    ],
    vatRate: 21,
  },
  {
    category: PRIPRAVA,
    description:
      'Ruční mlýnek Timemore Chestnut C3 s ocelovými kameny S2C. Rovnoměrné mletí od espressa po french press, hliníkové tělo a dřevěná klika.',
    gross: 189_000,
    lowStockThreshold: 3,
    name: 'Ruční mlýnek Timemore C3',
    shortDescription: 'Precizní ruční mlýnek s ocelovými kameny.',
    sku: 'KD-TIM-C3',
    slug: 'timemore-c3',
    stock: 2,
    vatRate: 21,
  },
  {
    category: PRIPRAVA,
    description:
      'Papírové filtry Hario pro dripper V60 velikosti 02, bělené, 100 kusů v balení. Dočasně vyprodáno, další dodávka je na cestě.',
    gross: 14_900,
    images: [],
    lowStockThreshold: 10,
    name: 'Papírové filtry Hario V60 02 (100 ks)',
    shortDescription: 'Bělené filtry pro V60 02 — dočasně vyprodáno.',
    sku: 'KD-HAR-FIL',
    slug: 'filtry-v60',
    stock: 0,
    vatRate: 21,
  },
  {
    category: PRIPRAVA,
    description:
      'Elektrická konvice s husím krkem a nastavitelnou teplotou 40–100 °C. Přesné nalévání pro překapávanou kávu i čaj, objem 0,8 l, udržování teploty 60 minut.',
    gross: 128_900,
    lowStockThreshold: 3,
    name: 'Konvice s husím krkem 0,8 l',
    shortDescription: 'Přesné nalévání a nastavitelná teplota.',
    sku: 'KD-KON-GOO',
    slug: 'konvice-gooseneck',
    stock: 7,
    vatRate: 21,
  },
  {
    category: DARKY,
    description:
      'Tři výběrové kávy po 100 g (Etiopie, Kolumbie, Keňa) v dárkové krabičce s průvodcem chutí a návodem na přípravu. Ideální pro začínající kávové objevitele.',
    gross: 59_000,
    lowStockThreshold: 4,
    name: 'Dárková sada Objevitel',
    shortDescription: '3× 100 g výběrové kávy v dárkové krabičce.',
    sku: 'KD-DAR-OBJ',
    slug: 'darkova-sada-objevitel',
    stock: 18,
    vatRate: 12,
  },
  {
    category: DARKY,
    description:
      'Dřevěná kazeta se čtyřmi čaji (Sencha, Earl Grey, Rooibos s vanilkou, Darjeeling) po 30 g a sítkem z nerezu. Krásný dárek pro milovníky čaje.',
    gross: 69_000,
    lowStockThreshold: 3,
    name: 'Čajová dárková kazeta',
    shortDescription: 'Čtyři čaje v dřevěné kazetě se sítkem.',
    sku: 'KD-DAR-CAJ',
    slug: 'cajova-kazeta',
    stock: 9,
    vatRate: 12,
  },
  {
    category: DARKY,
    description:
      'Startovací sada Domácí barista: keramický dripper V60 02, 100 filtrů a 250 g Etiopie Yirgacheffe. Připravujeme na Vánoce — zatím nezveřejněno v e-shopu.',
    gross: 119_000,
    lowStockThreshold: 3,
    name: 'Sada Domácí barista',
    published: false,
    shortDescription: 'Vše pro první překapávanou kávu (připravujeme).',
    sku: 'KD-DAR-BAR',
    slug: 'sada-domaci-barista',
    stock: 6,
    vatRate: 21,
  },
];

const productState = (product: SeedProduct): EncodedProduct => {
  const createdAt = daysAgo(120);
  const productId = productIdOf(product.slug);
  const variants = (product.variants ?? []).map((variant) => {
    const priceMinor = netForGross(variant.gross, product.vatRate);
    return {
      active: true,
      attributes: variant.attributes,
      id: variantIdOf(product.slug, variant.key),
      name: variant.name,
      priceHistory: [{ effectiveFrom: createdAt, priceMinor }],
      priceMinor,
      sku: `${product.sku}-${variant.key.toUpperCase()}`,
    };
  });
  const firstGross = product.gross ?? product.variants?.[0]?.gross ?? 0;
  const priceMinor = netForGross(firstGross, product.vatRate);
  const result: SeedProductState = {
    active: true,
    category: product.category,
    createdAt,
    currentPriceMinor: priceMinor,
    description: product.description,
    id: productId,
    // Main pack shot, a detail view and (for every other product) a lifestyle scene; the storefront renders them.
    images: product.images ?? [
      `/img/${product.slug}.svg`,
      `/img/${product.slug}--2.svg`,
      ...(product.slug.length % 2 === 0 ? [`/img/${product.slug}--3.svg`] : []),
    ],
    lowStockThreshold: product.lowStockThreshold,
    name: product.name,
    priceHistory: [{ effectiveFrom: createdAt, priceMinor }],
    published: product.published ?? true,
    shortDescription: product.shortDescription,
    sku: product.sku,
    slug: product.slug,
    unit: 'ks',
    updatedAt: createdAt,
    vatRate: product.vatRate,
  };
  if (product.stockTracked === false) {
    result.stockTracked = false;
  }
  if (variants.length > 0) {
    result.variants = variants;
  }
  if (product.weightGrams !== undefined) {
    result.weightGrams = product.weightGrams;
  }
  return result;
};

const openingMovements = (product: SeedProduct): EncodedMovement[] => {
  const productId = productIdOf(product.slug);
  const at = daysAgo(110);
  if (product.variants !== undefined) {
    return product.variants
      .filter((variant) => variant.stock > 0)
      .map((variant) => ({
        at,
        delta: variant.stock,
        id: demoId('eshop.movement', `receipt:${product.slug}:${variant.key}`),
        note: 'Počáteční stav',
        productId,
        reason: 'RECEIPT' as const,
        variantId: variantIdOf(product.slug, variant.key),
      }));
  }
  if (product.stockTracked === false || (product.stock ?? 0) <= 0) {
    return [];
  }
  return [
    {
      at,
      delta: product.stock ?? 0,
      id: demoId('eshop.movement', `receipt:${product.slug}`),
      note: 'Počáteční stav',
      productId,
      reason: 'RECEIPT',
    },
  ];
};

const statusLabels = {
  CANCELLED: 'Stornovaná',
  CONFIRMED: 'Zpracovává se',
  DELIVERED: 'Dokončená',
  NEW: 'Nová',
  PACKING: 'Připravená k předání',
  SHIPPED: 'Předáno dopravci (simulace)',
} satisfies Readonly<Record<OrderStatus, string>>;

interface SeedOrder {
  readonly address: { readonly city: string; readonly postalCode: string; readonly street: string };
  readonly contact: { readonly email: string; readonly name: string; readonly phone?: string };
  readonly createdDaysAgo: number;
  readonly key: string;
  readonly lines: readonly { readonly quantity: number; readonly slug: string; readonly variant?: string }[];
  readonly note?: string;
  readonly path: readonly OrderStatus[];
  readonly shipping: ShippingMethod;
}

/** Fictitious customers only (example.cz addresses, 555 numbers) — no real personal data. */
const sampleOrders: readonly SeedOrder[] = [
  {
    address: { city: 'Brno', postalCode: '602 00', street: 'Ukázková 12' },
    contact: { email: 'tereza.ukazkova@example.cz', name: 'Tereza Ukázková', phone: '+420 555 100 201' },
    createdDaysAgo: 9,
    key: 'o1',
    lines: [
      { quantity: 2, slug: 'etiopie-yirgacheffe', variant: '250g' },
      { quantity: 1, slug: 'hario-v60', variant: '02-bila' },
    ],
    path: ['NEW', 'CONFIRMED', 'PACKING', 'SHIPPED', 'DELIVERED'],
    shipping: 'ZASILKOVNA',
  },
  {
    address: { city: 'Praha 7', postalCode: '170 00', street: 'Testovací 45' },
    contact: { email: 'martin.demo@example.cz', name: 'Martin Demonstrační', phone: '+420 555 100 202' },
    createdDaysAgo: 4,
    key: 'o2',
    lines: [
      { quantity: 1, slug: 'espresso-domaci-smes', variant: '1kg' },
      { quantity: 1, slug: 'aeropress' },
    ],
    path: ['NEW', 'CONFIRMED', 'PACKING', 'SHIPPED'],
    shipping: 'PPL',
  },
  {
    address: { city: 'Olomouc', postalCode: '779 00', street: 'Fiktivní 3' },
    contact: { email: 'lucie.vzorova@example.cz', name: 'Lucie Vzorová' },
    createdDaysAgo: 2,
    key: 'o3',
    lines: [
      { quantity: 2, slug: 'sencha-kagoshima', variant: '50g' },
      { quantity: 1, slug: 'cajova-kazeta' },
    ],
    note: 'Prosím zabalit jako dárek.',
    path: ['NEW', 'CONFIRMED', 'PACKING'],
    shipping: 'CESKA_POSTA',
  },
  {
    address: { city: 'Plzeň', postalCode: '301 00', street: 'Modelová 88' },
    contact: { email: 'petr.priklad@example.cz', name: 'Petr Příklad', phone: '+420 555 100 204' },
    createdDaysAgo: 1,
    key: 'o4',
    lines: [
      { quantity: 3, slug: 'kolumbie-huila', variant: '250g' },
      { quantity: 1, slug: 'bialetti-moka', variant: '6' },
    ],
    path: ['NEW', 'CONFIRMED'],
    shipping: 'ZASILKOVNA',
  },
  {
    address: { city: 'Brno', postalCode: '612 00', street: 'Smyšlená 7' },
    contact: { email: 'eva.testova@example.cz', name: 'Eva Testová', phone: '+420 555 100 205' },
    createdDaysAgo: 0,
    key: 'o5',
    lines: [
      { quantity: 1, slug: 'darkova-sada-objevitel' },
      { quantity: 2, slug: 'espresso-mleta', variant: 'filtr' },
    ],
    path: ['NEW'],
    shipping: 'OSOBNI_ODBER',
  },
  {
    address: { city: 'Ostrava', postalCode: '702 00', street: 'Neexistující 21' },
    contact: { email: 'jan.zkusebni@example.cz', name: 'Jan Zkušební' },
    createdDaysAgo: 6,
    key: 'o6',
    lines: [{ quantity: 1, slug: 'timemore-c3' }],
    note: 'Zákazník objednávku zrušil telefonicky.',
    path: ['NEW', 'CANCELLED'],
    shipping: 'PPL',
  },
];

const buildOrder = Effect.fn('Merchandise.buildEshopOrder')(function* buildOrder(
  order: SeedOrder,
  index: number,
  products: readonly EncodedProduct[],
) {
  const lines = yield* Effect.forEach(
    order.lines,
    (line) =>
      Effect.gen(function* buildLine() {
        const product = products.find((entry) => entry.slug === line.slug);
        if (product === undefined) {
          return yield* new SeedProductMissing({ slug: line.slug });
        }
        const variant = product.variants?.find((entry) => entry.id === variantIdOf(line.slug, line.variant ?? ''));
        const net = variant?.priceMinor ?? product.currentPriceMinor;
        const snapshot: SeedOrderLine = {
          productId: product.id,
          productName: product.name,
          quantity: line.quantity,
          sku: variant?.sku ?? product.sku,
          unitPriceMinor: grossUnitPriceMinor(net, product.vatRate),
          vatRate: product.vatRate,
        };
        if (variant !== undefined) {
          snapshot.variantId = variant.id ?? '';
          snapshot.variantName = variant.name;
        }
        return snapshot;
      }),
    { concurrency: 1 },
  );
  const method = shippingMethods[order.shipping];
  const shipping = {
    label: method.label,
    method: order.shipping,
    priceMinor: method.grossPriceMinor,
    vatRate: 21 as const,
  };
  const totals = fullOrderTotals({ lines, pricesIncludeVat: true, shipping });
  const createdAt = daysAgo(order.createdDaysAgo, 3);
  const history: NonNullable<EncodedOrder['history']>[number][] = [
    { actorLabel: 'Zákazník – e-shop (DEMO)', after: statusLabels.NEW, at: createdAt, kind: 'CREATED' },
  ];
  let previous: OrderStatus = 'NEW';
  for (const [step, status] of order.path.slice(1).entries()) {
    const actor = status === 'PACKING' || status === 'SHIPPED' ? eshopDispatch : eshopAdmin;
    const entry: SeedOrderHistory = {
      actor,
      after: statusLabels[status],
      at: DateTime.formatIso(
        DateTime.add(DateTime.subtract(SEED_INSTANT, { days: order.createdDaysAgo, hours: 3 }), {
          minutes: (step + 1) * (order.createdDaysAgo >= 4 ? 1440 : 45),
        }),
      ),
      before: statusLabels[previous],
      kind: 'STATUS',
    };
    if (status === 'CANCELLED') {
      entry.reason = 'Storno na žádost zákazníka';
    }
    history.push(entry);
    previous = status;
  }
  const status = order.path.at(-1) ?? 'NEW';
  const last = history.at(-1)?.at ?? createdAt;
  const result: SeedOrderState = {
    channel: 'STOREFRONT',
    clientRequestId: `seed-${order.key}-0000-0000`,
    contact: order.contact,
    createdAt,
    deliveryAddress: { ...order.address, country: 'Česká republika' },
    demo: true,
    history,
    id: demoId('eshop.order', order.key),
    lines,
    number: `${ORDER_NUMBER_PREFIX}${String(index + 1).padStart(4, '0')}`,
    partyId: 'storefront-guest',
    pricesIncludeVat: true,
    shipping,
    status,
    totalMinor: totals.totalMinor,
    totalVatMinor: totals.totalVatMinor,
    updatedAt: last,
  };
  if (order.note !== undefined) {
    result.note = order.note;
  }
  return result;
});

export const buildEshopState = Effect.fn('Merchandise.buildEshopState')(function* buildEshopState() {
  const products = eshopCatalog.map(productState);
  const encoded: Encoded = {
    movements: eshopCatalog.flatMap(openingMovements),
    orders: yield* Effect.forEach(sampleOrders, (order, index) => buildOrder(order, index, products), {
      concurrency: 1,
    }),
    products,
  };
  return yield* Schema.decodeUnknownEffect(MerchandiseStateSchema)(encoded);
});

/** Adds missing seed records by id; keeps everything already present (demo edits, live orders). */
export const mergeSeed = (current: MerchandiseState, seed: MerchandiseState): MerchandiseState => {
  const productIds = new Set(current.products.map((entry) => entry.id));
  const movementIds = new Set(current.movements.map((entry) => entry.id));
  const orderIds = new Set(current.orders.map((entry) => entry.id));
  const orderNumbers = new Set(current.orders.map((entry) => entry.number));
  return {
    movements: [...current.movements, ...seed.movements.filter((entry) => !movementIds.has(entry.id))],
    orders: [
      ...current.orders,
      ...seed.orders.filter((entry) => !orderIds.has(entry.id) && !orderNumbers.has(entry.number)),
    ],
    products: [...current.products, ...seed.products.filter((entry) => !productIds.has(entry.id))],
  };
};

const AdminDatabaseLive = Layer.effect(
  PgClient.PgClient,
  Effect.gen(function* adminClient() {
    const connection = yield* Config.schema(
      Schema.Redacted(Schema.String.check(Schema.isMinLength(1))),
      'DATABASE_ADMIN_URL',
    );
    return yield* PgClient.makeClient({ url: connection });
  }),
).pipe(Layer.provide(Reactivity.layer));

const eshopScope = { legalEntityId: eshopLegalEntityId, tenantId: demoTenantId };

/** Restores seed products (prices, variants, images, flags) to their seed definition; keeps orders and extra data. */
export const restoreCatalog = (current: MerchandiseState, seed: MerchandiseState): MerchandiseState => {
  const merged = mergeSeed(current, seed);
  const seedProducts = new Map(seed.products.map((product) => [product.id, product] as const));
  return { ...merged, products: merged.products.map((product) => seedProducts.get(product.id) ?? product) };
};

const writeState = Effect.fn('Merchandise.writeEshopState')(function* writeEshopState(
  reset: boolean,
  restore: boolean,
) {
  const seed = yield* buildEshopState();
  const stored = yield* readCompanySnapshot(eshopScope);
  if (stored === undefined || reset) {
    yield* writeCompanySnapshot(eshopScope, seed);
    return yield* Console.log(
      `e-shop merchandise (Kavárna Doma) ${reset ? 'reset' : 'created'}: ${seed.products.length} products, ${seed.movements.length} movements, ${seed.orders.length} orders`,
    );
  }
  const current = stored.state;
  const merged = restore ? restoreCatalog(current, seed) : mergeSeed(current, seed);
  const added =
    merged.products.length -
    current.products.length +
    merged.movements.length -
    current.movements.length +
    merged.orders.length -
    current.orders.length;
  if (added === 0 && !restore) {
    return yield* Console.log(
      `e-shop merchandise (Kavárna Doma) already seeded: ${current.products.length} products, ${current.orders.length} orders; nothing changed`,
    );
  }
  yield* writeCompanySnapshot(eshopScope, merged);
  return yield* Console.log(
    restore
      ? `e-shop merchandise (Kavárna Doma) catalog restored to seed prices/variants; ${current.orders.length} orders kept`
      : `e-shop merchandise (Kavárna Doma) merged: ${added} missing seed records added`,
  );
});

const command = Command.make(
  'merchandise-seed-eshop',
  {
    reset: Flag.Boolean('reset').pipe(Flag.withDefault(false)),
    restoreCatalog: Flag.Boolean('restore-catalog').pipe(Flag.withDefault(false)),
    validateOnly: Flag.Boolean('validate-only').pipe(Flag.withDefault(false)),
  },
  ({ reset, restoreCatalog: restore, validateOnly }) =>
    validateOnly
      ? buildEshopState().pipe(
          Effect.flatMap((state) =>
            Schema.encodeEffect(MerchandiseStateSchema)(state).pipe(
              Effect.andThen(
                Console.log(
                  `e-shop seed validated: ${state.products.length} products, ${state.movements.length} movements, ${state.orders.length} orders; no data changed`,
                ),
              ),
            ),
          ),
        )
      : Layer.build(Layer.effectDiscard(writeState(reset, restore)).pipe(Layer.provide(AdminDatabaseLive))).pipe(
          Effect.scoped,
        ),
);

const appRoot = new URL('../../..', import.meta.url).pathname;

const program = Effect.gen(function* seedProgram() {
  const fileProvider = yield* ConfigProvider.fromDotEnv({ path: `${appRoot}.env` });
  const provider = ConfigProvider.orElse(ConfigProvider.fromEnv(), fileProvider);
  return yield* Layer.build(
    Layer.effectDiscard(Command.run(command, { version: '1.0.0' })).pipe(
      Layer.provide(Layer.mergeAll(NodeServices.layer, ConfigProvider.layer(provider))),
    ),
  ).pipe(Effect.scoped);
});

NodeRuntime.runMain(program.pipe(Effect.provide(NodeServices.layer)));
