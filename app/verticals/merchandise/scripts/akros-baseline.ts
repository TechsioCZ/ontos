// Pure AKROS baseline builder: the seed CLI (akros-catalog.mts) and the in-app admin reset build the same state.
import type { MerchandiseStateSchema } from '../shared/apis/records.ts';
import { decodeCategoryText, orderCategoryPositions, stripUnbackedDiscount } from './akros-merge.ts';
import { akrosSampleContacts } from './order-presentation.ts';

export type AkrosEncodedState = typeof MerchandiseStateSchema.Encoded;
type Encoded = AkrosEncodedState;
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
  isAction: boolean;
  isRecommended: boolean;
  isSale: boolean;
  isNew: boolean;
}
export interface SourceProduct {
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
  unit: string;
  imageSrc: string;
  imageAlt: string;
  secondaryImageSrc?: string;
  featuredPosition: number | null;
  isAction: boolean;
  isRecommended: boolean;
  isSale: boolean;
  isNew: boolean;
  detail: { descriptionParagraphs: string[]; parameters: Parameter[]; priceTiers: Tier[]; variants: Variant[] };
}
export interface Category {
  id: string;
  parentId: string | null;
  name: string;
  slug: string;
  heading?: string;
  description?: string;
  longDescription?: string;
  position?: number;
  imageSrc?: string;
  imageAlt?: string;
  hasChildren?: boolean;
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
    unit: productUnitOf(product.unit),
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
    shortDescription: stripUnbackedDiscount(product.description).slice(0, 500),
    imageSrc: product.imageSrc,
    imageAlt: product.imageAlt.slice(0, 300),
    description: stripUnbackedDiscount(product.detail.descriptionParagraphs.join('\n\n') || product.description),
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
      isAction: variant.isAction,
      isRecommended: variant.isRecommended,
      isSale: variant.isSale,
      isNew: variant.isNew,
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
  return {
    products,
    movements,
    orders,
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
        })),
    ),
    homepageFeaturedProductIds: catalog.homepageFeaturedProductIds,
  };
};
