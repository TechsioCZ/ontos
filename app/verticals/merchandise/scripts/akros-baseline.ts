// Pure AKROS baseline builder: the seed CLI (akros-catalog.mts) and the in-app admin reset build the same state.
import type { MerchandiseStateSchema } from '../shared/apis/records.ts';
import { decodeCategoryText, orderCategoryPositions, stripUnbackedDiscount } from './akros-merge.ts';
import { akrosSampleContacts } from './order-presentation.ts';
import { applyDemoPriceTiers } from './akros-price-tiers.ts';

export type AkrosEncodedState = typeof MerchandiseStateSchema.Encoded;
type Encoded = AkrosEncodedState;
interface Tier {
  minimumQuantity: number;
  priceExcludingVatMinor: number;
  priceMinor: number;
}
interface Parameter {
  label: string;
  unit: string;
  value: string;
}
interface Variant {
  id: string;
  imageSrc?: string;
  isAction: boolean;
  isNew: boolean;
  isRecommended: boolean;
  isSale: boolean;
  label: string;
  minimumQuantity: number;
  packageQuantity?: number;
  parameters: Parameter[];
  priceMinor: number;
  priceTiers: Tier[];
  sku: string;
  sourceId: string;
  stockCount: number;
  unit: string;
}
export interface SourceProduct {
  categoryId: string;
  description: string;
  detail: { descriptionParagraphs: string[]; parameters: Parameter[]; priceTiers: Tier[]; variants: Variant[] };
  featuredPosition: number | null;
  id: string;
  imageAlt: string;
  imageSrc: string;
  isAction: boolean;
  isNew: boolean;
  isRecommended: boolean;
  isSale: boolean;
  minimumQuantity: number;
  name: string;
  packageQuantity?: number;
  priceMinor: number;
  secondaryImageSrc?: string;
  sku: string;
  slug: string;
  sourceGroupId: string;
  stockCount: number;
  unit: string;
}
export interface Category {
  description?: string;
  hasChildren?: boolean;
  heading?: string;
  id: string;
  imageAlt?: string;
  imageSrc?: string;
  longDescription?: string;
  name: string;
  parentId: string | null;
  position?: number;
  slug: string;
}
export interface AkrosSource {
  readonly catalog: { homepageFeaturedProductIds: string[]; products: SourceProduct[] };
  readonly categories: Category[];
}
/** Deterministic fixture identity, `demoId(namespace, key)` from scripts/demo/fixture-ids.mts. */
export type DemoId = (namespace: string, key: string) => string;
const productUnitOf = (unit: string): Encoded['products'][number]['unit'] =>
  unit === 'm' || unit === 'tab' || unit === 'set' ? unit : 'ks';
const at = '2026-10-19T08:00:00.000Z';
const fieldsFor = (source: {
  minimumQuantity: number;
  packageQuantity?: number;
  parameters: Parameter[];
  priceTiers: Tier[];
  unit: string;
}) => ({
  minimumQuantity: source.minimumQuantity,
  ...(source.packageQuantity === undefined ? {} : { packageQuantity: source.packageQuantity }),
  parameters: source.parameters,
  priceTiers: source.priceTiers,
  sourceUnit: source.unit,
});
/** Feed root branches AKROS keeps out of the storefront navigation (internal „Mimo menu“, UNC thread nuts). */
export const AKROS_HIDDEN_CATEGORY_IDS: ReadonlySet<string> = new Set(['322', '3504']);

/** Catalogue-only groups are not replenished. Stocked groups keep a small, unit-aware reserve. */
export const akrosMinimumStock = (stock: number): number =>
  stock <= 0 ? 0 : Math.min(100, Math.max(1, Math.floor(stock / 5)));

export const buildAkrosEncodedFrom = (source: AkrosSource, demoId: DemoId): Encoded => {
  const { catalog, categories } = source;
  // Import every source group; never silently curate the live owner catalog.
  const akrosSourceProducts = catalog.products;
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
  const sourceProducts: Encoded['products'] = akrosSourceProducts.map((product) => ({
    ...fieldsFor({ ...product, ...product.detail }),
    active: true,
    category: byCategory.get(product.categoryId)?.name ?? 'Spojovací materiál',
    categoryId: product.categoryId,
    categoryPathIds: pathFor(product.categoryId),
    createdAt: at,
    currentPriceMinor: product.detail.priceTiers[0]?.priceExcludingVatMinor ?? Math.round(product.priceMinor / 1.21),
    description: stripUnbackedDiscount(product.detail.descriptionParagraphs.join('\n\n') || product.description),
    featuredPosition: product.featuredPosition,
    id: product.id,
    imageAlt: product.imageAlt.slice(0, 300),
    images: [product.imageSrc, ...(product.secondaryImageSrc === undefined ? [] : [product.secondaryImageSrc])],
    imageSrc: product.imageSrc,
    isAction: product.isAction,
    isNew: product.isNew,
    isRecommended: product.isRecommended,
    isSale: product.isSale,
    lowStockThreshold: akrosMinimumStock(
      product.detail.variants.length === 0
        ? product.stockCount
        : product.detail.variants.reduce((stock, variant) => stock + variant.stockCount, 0),
    ),
    name: product.name,
    priceHistory: [],
    published: true,
    shortDescription: stripUnbackedDiscount(product.description).slice(0, 500),
    sku: product.sku,
    slug: product.slug,
    sourceGroupId: product.sourceGroupId,
    sourceProductId: product.id,
    stockTracked: true,
    unit: productUnitOf(product.unit),
    updatedAt: at,
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
      isAction: variant.isAction,
      isRecommended: variant.isRecommended,
      isSale: variant.isSale,
      isNew: variant.isNew,
    })),
    vatRate: 21,
  }));
  const products = sourceProducts.map(applyDemoPriceTiers);
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
      channel: 'STOREFRONT',
      clientRequestId: `akros-sample-order-${index}`,
      contact: akrosSampleContacts[index]!,
      createdAt: at,
      deliveryAddress: { city: 'Brno', postalCode: '602 00', street: 'Ukázková 12', country: 'CZ' },
      demo: true,
      history: [{ kind: 'CREATED', at, actorLabel: 'Zákazník – AKROS (DEMO)', after: status }],
      id: demoId('akros.order', String(index)),
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
      number: `OBJ-2026-${String(index + 1).padStart(4, '0')}`,
      partyId: 'storefront-guest',
      pricesIncludeVat: true,
      shipping: { method: 'OSOBNI_ODBER', label: 'Osobní odběr – AKROS (simulace)', priceMinor: 0, vatRate: 21 },
      status,
      totalMinor,
      totalVatMinor: totalMinor - Math.round(totalMinor / 1.21),
      updatedAt: at,
    };
  });
  return {
    categories: orderCategoryPositions(
      categories
        .map((source) => decodeCategoryText(source))
        .map((category) => ({
          ...category,
          heading: category.heading ?? category.name,
          description: category.description ?? '',
          longDescription: category.longDescription ?? '',
          position: category.position ?? 0,
          imageSrc: category.imageSrc ?? '',
          imageAlt: category.imageAlt ?? category.name,
          hasChildren: category.hasChildren ?? false,
          ...(AKROS_HIDDEN_CATEGORY_IDS.has(category.id) ? { published: false } : {}),
        })),
    ),
    homepageFeaturedProductIds: catalog.homepageFeaturedProductIds,
    movements,
    orders,
    products,
  };
};
