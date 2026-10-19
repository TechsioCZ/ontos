// DEVELOPMENT ONLY (ESHOP_FIXTURE=1): an in-memory stand-in shaped like the merchandise records read, used to
// build the UI while the backend is offline. The demo never runs with it; /api/health reports `fixture: true`.
type Raw = Record<string, unknown>;

const gross = (net: number, vat: number) => net + Math.floor((net * vat + 50) / 100);

const variant = (id: string, name: string, sku: string, net: number, stock: number, vat = 12): Raw => ({
  active: true,
  attributes: '',
  availability: stock <= 0 ? 'OUT_OF_STOCK' : stock < 5 ? 'LOW_STOCK' : 'IN_STOCK',
  grossPriceMinor: gross(net, vat),
  id,
  name,
  priceHistory: [],
  priceMinor: net,
  sku,
  stockOnHand: stock,
});

const coffee = (id: string, name: string, slug: string, short: string, base: number, stock: [number, number, number, number]): Raw => ({
  active: true,
  category: 'Káva',
  createdAt: '2026-10-01T08:00:00.000Z',
  currentPriceMinor: base,
  description: `${short}\n\nPražíme v malých várkách v Brně každé úterý a čtvrtek. Káva je vhodná pro filtr i espresso, mletou verzi melem na střední hrubost pro překapávač.`,
  grossPriceMinor: gross(base, 12),
  id,
  images: [`/img/${slug}.svg`, `/img/${slug}--2.svg`, `/img/${slug}--3.svg`],
  lowStock: false,
  name,
  shortDescription: short,
  sku: id.toUpperCase(),
  slug,
  stockOnHand: stock.reduce((a, b) => a + b, 0),
  unit: 'bal',
  variantRecords: [
    variant(`${id}-250z`, '250 g / zrnková', `${id.toUpperCase()}-250-Z`, base, stock[0]),
    variant(`${id}-250m`, '250 g / mletá', `${id.toUpperCase()}-250-M`, base, stock[1]),
    variant(`${id}-1kz`, '1 kg / zrnková', `${id.toUpperCase()}-1K-Z`, Math.round(base * 3.4), stock[2]),
    variant(`${id}-1km`, '1 kg / mletá', `${id.toUpperCase()}-1K-M`, Math.round(base * 3.4), stock[3]),
  ],
  vatRate: 12,
  weightGrams: 250,
});

const simple = (id: string, category: string, name: string, slug: string, short: string, net: number, stock: number, vat = 21, extra: Raw = {}): Raw => ({
  active: true,
  availability: stock <= 0 ? 'OUT_OF_STOCK' : stock < 5 ? 'LOW_STOCK' : 'IN_STOCK',
  category,
  createdAt: '2026-10-05T08:00:00.000Z',
  currentPriceMinor: net,
  description: `${short}\n\nDemo popis produktu pro prezentaci e-shopu Kavárna Doma.`,
  grossPriceMinor: gross(net, vat),
  id,
  images: [`/img/${slug}.svg`, `/img/${slug}--2.svg`],
  lowStock: stock < 5,
  name,
  shortDescription: short,
  sku: id.toUpperCase(),
  slug,
  stockOnHand: stock,
  unit: 'ks',
  vatRate: vat,
  ...extra,
});

const products: Raw[] = [
  coffee('kd-eti', 'Etiopie Yirgacheffe', 'etiopie-yirgacheffe', 'Květinová káva s tóny jasmínu, bergamotu a meruňky.', 26_700, [24, 12, 6, 0]),
  coffee('kd-col', 'Kolumbie Huila', 'kolumbie-huila', 'Vyvážená káva s tóny mléčné čokolády, karamelu a červeného jablka.', 23_200, [30, 18, 9, 4]),
  coffee('kd-bra', 'Brazílie Cerrado', 'brazilie-cerrado', 'Sladká espresso klasika: lískový oříšek, kakao a hnědý cukr.', 19_600, [40, 22, 15, 10]),
  coffee('kd-ken', 'Keňa Nyeri AA', 'kena-nyeri-aa', 'Šťavnatá káva s tóny černého rybízu, grapefruitu a třtinového cukru.', 31_200, [0, 0, 0, 0]),
  simple('kd-gt', 'Káva', 'Guatemala Antigua – bezkofeinová', 'guatemala-bezkofeinova', 'Bezkofeinová káva zpracovaná metodou Swiss Water, tóny kakaa a pomeranče.', 24_500, 14, 12),
  simple('kd-sen', 'Čaj', 'Japonská Sencha Asamushi', 'sencha-asamushi', 'Zelený čaj s travnatou sladkostí a jemnou umami chutí. 100 g.', 25_900, 18, 12),
  simple('kd-earl', 'Čaj', 'Earl Grey s chrpou', 'earl-grey-chrpa', 'Černý čaj z Assamu s bergamotem a modrými květy chrpy. 100 g.', 17_800, 3, 12),
  simple('kd-mat', 'Čaj', 'Matcha Ceremonial', 'matcha-ceremonial', 'Obřadní matcha z Uji, sytě zelená, krémová a bez hořkosti. 30 g.', 44_500, 0, 12),
  simple('kd-roo', 'Čaj', 'Rooibos Vanilka & Karamel', 'rooibos-vanilka', 'Bezkofeinový rooibos s vanilkou a kousky karamelu. 100 g.', 14_200, 26, 12, { stockTracked: false, availability: 'UNKNOWN', lowStock: false }),
  simple('kd-v60', 'Příprava kávy', 'Dripper V60 keramický', 'dripper-v60', 'Keramický překapávač pro 1–4 šálky, spirálová žebra pro rovnoměrný průtok.', 54_500, 12),
  simple('kd-ket', 'Příprava kávy', 'Konvice s husím krkem 0,9 l', 'konvice-husi-krk', 'Nerezová konvice s přesným výtokem a teploměrem ve víku.', 103_300, 7),
  simple('kd-grn', 'Příprava kávy', 'Ruční mlýnek s keramickými kameny', 'rucni-mlynek', 'Ruční mlýnek s nastavitelnou hrubostí od espressa po french press.', 136_300, 2),
  simple('kd-fp', 'Příprava kávy', 'French press 1 l', 'french-press', 'Borosilikátové sklo a nerezové sítko, pro 4–6 šálků.', 74_300, 0),
  simple('kd-mug', 'Příprava kávy', 'Keramický hrnek Doma 300 ml', 'hrnek-doma', 'Ručně glazovaný hrnek z jihomoravské keramické dílny.', 28_100, 35),
  simple('kd-flt', 'Příprava kávy', 'Papírové filtry V60, 100 ks', 'filtry-v60', 'Nebělené papírové filtry velikosti 02.', 13_100, 60),
];

const orders: Raw[] = [
  { lines: [{ productId: 'kd-col', quantity: 9 }], status: 'DELIVERED' },
  { lines: [{ productId: 'kd-eti', quantity: 7 }, { productId: 'kd-v60', quantity: 3 }], status: 'NEW' },
  { lines: [{ productId: 'kd-bra', quantity: 5 }, { productId: 'kd-mug', quantity: 4 }], status: 'NEW' },
];

let revision = 7;

export const loadFixtureRecords = (): Raw => ({ orders, products, revision });

/** Dev stand-in for PlaceStorefrontOrder: idempotent by clientRequestId, prices re-validated. */
export const placeFixtureOrder = (command: Raw): Raw => {
  const existing = orders.find((order) => order.clientRequestId === command.clientRequestId);
  if (existing !== undefined) return { ...(existing.result as Raw), outcome: 'REPLAYED' };
  const issues: Raw[] = [];
  const lines = (command.lines as Raw[]).map((line) => {
    const product = products.find((item) => item.id === line.productId) as Raw;
    const variants = (product.variantRecords as Raw[] | undefined) ?? [];
    const chosen = variants.find((item) => item.id === line.variantId) ?? product;
    const unit = chosen.grossPriceMinor as number;
    if (unit !== line.expectedUnitPriceMinor) issues.push({ code: 'PRICE_CHANGED', currentUnitPriceMinor: unit, expectedUnitPriceMinor: line.expectedUnitPriceMinor, message: `Cena položky ${String(product.name)} se změnila.`, productId: product.id, variantId: line.variantId });
    if (chosen.availability === 'OUT_OF_STOCK') issues.push({ code: 'OUT_OF_STOCK', message: `${String(product.name)} není skladem.`, productId: product.id, variantId: line.variantId });
    return { lineTotalMinor: unit * (line.quantity as number), name: product.name, productId: product.id, quantity: line.quantity, sku: chosen.sku, unitPriceMinor: unit, variantId: line.variantId, variantName: chosen === product ? undefined : chosen.name };
  });
  if (issues.length > 0) return { issues, lines, outcome: 'REJECTED' };
  const shippingPriceMinor = ({ CESKA_POSTA: 11_900, OSOBNI_ODBER: 0, PPL: 12_900, ZASILKOVNA: 7_900 } as Record<string, number>)[String(command.shippingMethod)] ?? 0;
  const totalMinor = lines.reduce((sum, line) => sum + line.lineTotalMinor, 0) + shippingPriceMinor;
  revision += 1;
  const number = `OBJ-2026-${String(100 + orders.length).padStart(4, '0')}`;
  const result = { issues: [], lines, orderId: `ord-${revision}`, orderNumber: number, outcome: 'PLACED', shippingPriceMinor, status: 'NEW', totalMinor, totalVatMinor: Math.round(totalMinor * 0.12) };
  orders.push({ channel: 'STOREFRONT', clientRequestId: command.clientRequestId, contact: command.contact, createdAt: new Date().toISOString(), id: result.orderId, lines, number, result, shipping: { label: String(command.shippingMethod), method: command.shippingMethod, priceMinor: shippingPriceMinor, vatRate: 21 }, status: 'NEW', totalMinor, totalVatMinor: result.totalVatMinor });
  return result;
};
