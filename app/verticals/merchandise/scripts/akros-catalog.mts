import { readFileSync } from 'node:fs';
import { demoId } from '../../../scripts/demo/fixture-ids.mts';
import type { MerchandiseStateSchema } from '../shared/apis/records.ts';
import { akrosSampleContacts } from './order-presentation.ts';

type Encoded = typeof MerchandiseStateSchema.Encoded;
interface Tier {
  minimumQuantity: number;
  priceMinor: number;
  priceExcludingVatMinor: number;
}
interface Parameter {
  label: string;
  value: string;
  unit: string;
}
interface Variant {
  id: string;
  sourceId: string;
  sku: string;
  label: string;
  minimumQuantity: number;
  packageQuantity?: number;
  priceMinor: number;
  stockCount: number;
  unit: string;
  priceTiers: Tier[];
  parameters: Parameter[];
  imageSrc?: string;
}
interface SourceProduct {
  id: string;
  sourceGroupId: string;
  slug: string;
  categoryId: string;
  name: string;
  sku: string;
  description: string;
  priceMinor: number;
  minimumQuantity: number;
  packageQuantity?: number;
  stockCount: number;
  unit: Encoded['products'][number]['unit'];
  imageSrc: string;
  secondaryImageSrc?: string;
  featuredPosition: number | null;
  isAction: boolean;
  isRecommended: boolean;
  isSale: boolean;
  isNew: boolean;
  detail: { descriptionParagraphs: string[]; parameters: Parameter[]; priceTiers: Tier[]; variants: Variant[] };
}
interface Category {
  id: string;
  parentId: string | null;
  name: string;
  slug: string;
}
const catalog = JSON.parse(
  readFileSync(
    new URL('../../../akros-storefront/src/mock-storefront/generated/catalog.generated.json', import.meta.url),
    'utf8',
  ),
) as { homepageFeaturedProductIds: string[]; products: SourceProduct[] };
const categories = (
  JSON.parse(
    readFileSync(
      new URL('../../../akros-storefront/src/mock-storefront/generated/categories.generated.json', import.meta.url),
      'utf8',
    ),
  ) as { categories: Category[] }
).categories;
const byCategory = new Map(categories.map((category) => [category.id, category]));
const pathFor = (id: string): string[] => {
  const path: string[] = [];
  let next: string | null = id;
  while (next !== null && !path.includes(next)) {
    path.push(next);
    next = byCategory.get(next)?.parentId ?? null;
  }
  return path;
};
const mainSlugs = [
  'srouby',
  'matice',
  'podlozky',
  'zavitove-tyce-a-svorniky',
  'vruty',
  'koliky',
  'nyty',
  'bezpecnostni-srouby-a-vruty',
  'ostatni-spojovaci-material',
  'lanaretezypantyjachtdopln',
  'kotevni-technikalepidla',
  'naradi-a-prislusenstvi',
  'maziva',
  'solar-system',
  'nerez-cerny-design',
  'plechy',
  'trubky',
  'profily',
  'tyce',
  'kolena',
  'priruby',
  'armatury-1',
  'potravinarske-armatury',
  'prislusenstvi',
  'mazaci-hlavice',
  'matice-km-a-podlozky-mb',
];
const selected = new Map<string, SourceProduct>();
const add = (product: SourceProduct) => selected.set(product.id, product);
// Preserve every homepage promotion/featured group, then spread the remaining budget across navigation.
for (const product of catalog.products) {
  if (
    catalog.homepageFeaturedProductIds.includes(product.id) ||
    product.featuredPosition !== null ||
    product.isNew ||
    product.isRecommended ||
    product.isSale ||
    product.isAction
  )
    add(product);
}
const buckets = mainSlugs.map((slug) => {
  const category = categories.find((entry) => entry.slug === slug);
  return category === undefined
    ? []
    : catalog.products.filter((product) => pathFor(product.categoryId).includes(category.id));
});
for (let index = 0; selected.size < 230 && index < catalog.products.length; index += 1) {
  for (const bucket of buckets) {
    const product = bucket[index];
    if (product !== undefined) add(product);
    if (selected.size >= 230) break;
  }
}
export const akrosSourceProducts = [...selected.values()];
const at = '2026-10-19T08:00:00.000Z';
const fieldsFor = (source: {
  minimumQuantity: number;
  packageQuantity?: number;
  priceTiers: Tier[];
  parameters: Parameter[];
  unit: string;
}) => ({
  minimumQuantity: source.minimumQuantity,
  ...(source.packageQuantity === undefined ? {} : { packageQuantity: source.packageQuantity }),
  parameters: source.parameters,
  priceTiers: source.priceTiers,
  sourceUnit: source.unit,
});
export const buildAkrosEncoded = (): Encoded => {
  const products: Encoded['products'] = akrosSourceProducts.map((product) => ({
    ...fieldsFor({ ...product, ...product.detail }),
    active: true,
    category: byCategory.get(product.categoryId)?.name ?? 'Spojovací materiál',
    categoryId: product.categoryId,
    categoryPathIds: pathFor(product.categoryId),
    createdAt: at,
    updatedAt: at,
    currentPriceMinor: product.detail.priceTiers[0]?.priceExcludingVatMinor ?? Math.round(product.priceMinor / 1.21),
    id: product.id,
    name: product.name,
    sku: product.sku,
    slug: product.slug,
    unit: product.unit,
    vatRate: 21,
    lowStockThreshold: 5,
    published: true,
    stockTracked: true,
    priceHistory: [],
    sourceProductId: product.id,
    sourceGroupId: product.sourceGroupId,
    featuredPosition: product.featuredPosition,
    isAction: product.isAction,
    isRecommended: product.isRecommended,
    isSale: product.isSale,
    isNew: product.isNew,
    description: product.detail.descriptionParagraphs.join('\n\n') || product.description,
    images: [product.imageSrc, ...(product.secondaryImageSrc === undefined ? [] : [product.secondaryImageSrc])],
    variants: product.detail.variants.map((variant) => ({
      ...fieldsFor(variant),
      unit: variant.unit,
      id: variant.id,
      sourceId: variant.sourceId,
      sku: variant.sku,
      name: variant.label,
      active: true,
      attributes: variant.parameters
        .map((parameter) => `${parameter.label}: ${parameter.value} ${parameter.unit}`)
        .join('; ')
        .slice(0, 1000),
      imageSrc: variant.imageSrc ?? product.imageSrc,
      priceMinor: variant.priceTiers[0]?.priceExcludingVatMinor ?? Math.round(variant.priceMinor / 1.21),
      priceHistory: [],
    })),
  }));
  const movements: Encoded['movements'] = akrosSourceProducts.flatMap((product) => {
    const units = product.detail.variants.length > 0 ? product.detail.variants : [{ ...product, id: undefined }];
    return units
      .filter((unit) => unit.stockCount !== 0)
      .map((unit) => ({
        id: demoId('akros.receipt', unit.id ?? product.id),
        productId: product.id,
        ...(unit.id === undefined ? {} : { variantId: unit.id }),
        at,
        delta: unit.stockCount,
        note: 'Výchozí sklad AKROS (demo)',
        reason: 'RECEIPT' as const,
      }));
  });
  const statuses = ['NEW', 'CONFIRMED', 'PACKING', 'SHIPPED', 'DELIVERED', 'CANCELLED'] as const;
  const orders: Encoded['orders'] = statuses.map((status, index) => {
    const source =
      akrosSourceProducts.find(
        (product, position) =>
          position >= index && product.detail.variants.some((variant) => variant.stockCount >= variant.minimumQuantity),
      ) ?? akrosSourceProducts[0]!;
    const variant =
      source.detail.variants.find((entry) => entry.stockCount >= entry.minimumQuantity) ?? source.detail.variants[0]!;
    const quantity =
      variant.packageQuantity === undefined
        ? Math.max(variant.minimumQuantity, 1)
        : Math.ceil(Math.max(variant.minimumQuantity, 1) / variant.packageQuantity) * variant.packageQuantity;
    const tier =
      variant.priceTiers.filter((entry) => entry.minimumQuantity <= quantity).at(-1) ?? variant.priceTiers[0]!;
    const totalMinor = Math.round(quantity * tier.priceMinor);
    return {
      id: demoId('akros.order', String(index)),
      clientRequestId: `akros-sample-order-${index}`,
      number: `OBJ-2026-${String(index + 1).padStart(4, '0')}`,
      channel: 'STOREFRONT',
      demo: true,
      status,
      pricesIncludeVat: true,
      createdAt: at,
      updatedAt: at,
      partyId: 'storefront-guest',
      contact: akrosSampleContacts[index]!,
      deliveryAddress: { city: 'Brno', postalCode: '602 00', street: 'Ukázková 12', country: 'CZ' },
      lines: [
        {
          productId: source.id,
          productName: source.name,
          variantId: variant.id,
          variantName: variant.label,
          sku: variant.sku,
          quantity,
          unitPriceMinor: tier.priceMinor,
          vatRate: 21,
        },
      ],
      shipping: { method: 'OSOBNI_ODBER', label: 'Osobní odběr – AKROS (simulace)', priceMinor: 0, vatRate: 21 },
      totalMinor,
      totalVatMinor: totalMinor - Math.round(totalMinor / 1.21),
      history: [{ kind: 'CREATED', at, actorLabel: 'Zákazník – AKROS (DEMO)', after: status }],
    };
  });
  return { products, movements, orders };
};
