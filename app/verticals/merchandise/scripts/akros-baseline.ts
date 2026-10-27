// Pure AKROS baseline builder: the seed CLI (akros-catalog.mts) and the in-app admin reset build the same state.
import { Effect, Option, Schema } from 'effect';
import type { MerchandiseStateSchema } from '../shared/apis/records.ts';
import type { VatRate } from '../shared/domain/merchandise-model.ts';
import {
  CatalogSourceIdSchema,
  CategoryIdSchema,
  ProductReferenceSchema,
  SourceGroupIdSchema,
  VariantReferenceSchema,
} from '../shared/domain/merchandise-model.ts';
import { decodeCategoryText, orderCategoryPositions, stripUnbackedDiscount } from './akros-merge.ts';
import { akrosSampleContacts } from './order-presentation.ts';
import { applyDemoPriceTiers } from './akros-price-tiers.ts';

export type AkrosEncodedState = typeof MerchandiseStateSchema.Encoded;
interface BaselineStockSource {
  readonly id?: string;
  readonly stockCount: number;
}
type BaselineMovementIdentity = Pick<AkrosEncodedState['movements'][number], 'id' | 'productId' | 'variantId'>;
const tierFields = { minimumQuantity: Schema.Finite };
const TierSchema = Schema.Struct(
  Object.assign(tierFields, { priceMinor: Schema.Finite }, { priceExcludingVatMinor: Schema.Finite }),
);
const ParameterSchema = Schema.Struct({ label: Schema.String, unit: Schema.String, value: Schema.String });
/** The feed and bundled baseline serialize each parameter as label, value, then unit. */
const parameterForBaseline = (parameter: typeof ParameterSchema.Type) => {
  const label = { label: parameter.label };
  return Object.assign(label, { value: parameter.value }, { unit: parameter.unit });
};
const VariantSchema = Schema.Struct({
  id: VariantReferenceSchema,
  imageSrc: Schema.optionalKey(Schema.String),
  isAction: Schema.Boolean,
  isNew: Schema.Boolean,
  isRecommended: Schema.Boolean,
  isSale: Schema.Boolean,
  label: Schema.String,
  minimumQuantity: Schema.Finite,
  packageQuantity: Schema.optionalKey(Schema.Finite),
  parameters: Schema.Array(ParameterSchema),
  priceMinor: Schema.Finite,
  priceTiers: Schema.NonEmptyArray(TierSchema),
  sku: Schema.String,
  sourceId: CatalogSourceIdSchema,
  stockCount: Schema.Finite,
  unit: Schema.String,
});
export const SourceProductSchema = Schema.Struct({
  categoryId: CategoryIdSchema,
  description: Schema.String,
  detail: Schema.Struct({
    descriptionParagraphs: Schema.Array(Schema.String),
    parameters: Schema.Array(ParameterSchema),
    priceTiers: Schema.Array(TierSchema),
    variants: Schema.Array(VariantSchema),
  }),
  featuredPosition: Schema.OptionFromNullOr(Schema.Finite),
  id: ProductReferenceSchema,
  imageAlt: Schema.String,
  imageSrc: Schema.String,
  isAction: Schema.Boolean,
  isNew: Schema.Boolean,
  isRecommended: Schema.Boolean,
  isSale: Schema.Boolean,
  minimumQuantity: Schema.Finite,
  name: Schema.String,
  packageQuantity: Schema.optionalKey(Schema.Finite),
  priceMinor: Schema.Finite,
  secondaryImageSrc: Schema.optionalKey(Schema.String),
  sku: Schema.String,
  slug: Schema.String,
  sourceGroupId: SourceGroupIdSchema,
  stockCount: Schema.Finite,
  unit: Schema.String,
});
export type SourceProduct = typeof SourceProductSchema.Type;
// Field order is part of the bundled baseline's byte contract.
const categoryFields = { id: CategoryIdSchema };
const categoryIdentityFields = Object.assign(
  categoryFields,
  { parentId: Schema.OptionFromNullOr(CategoryIdSchema) },
  { slug: Schema.String },
);
const categoryNameFields = Object.assign(
  categoryIdentityFields,
  { name: Schema.String },
  { heading: Schema.optionalKey(Schema.String) },
);
const categoryDescriptionFields = Object.assign(
  categoryNameFields,
  { description: Schema.optionalKey(Schema.String) },
  { longDescription: Schema.optionalKey(Schema.String) },
);
const categoryPositionFields = Object.assign(
  categoryDescriptionFields,
  { position: Schema.optionalKey(Schema.Finite) },
  { imageSrc: Schema.optionalKey(Schema.String) },
);
export const CategorySchema = Schema.Struct(
  Object.assign(
    categoryPositionFields,
    { imageAlt: Schema.optionalKey(Schema.String) },
    { hasChildren: Schema.optionalKey(Schema.Boolean) },
  ),
);
export type Category = typeof CategorySchema.Type;
export const AkrosCatalogSchema = Schema.Struct({
  homepageFeaturedProductIds: Schema.Array(ProductReferenceSchema),
  products: Schema.NonEmptyArray(SourceProductSchema),
});
export interface AkrosSource {
  readonly catalog: typeof AkrosCatalogSchema.Type;
  readonly categories: readonly Category[];
}
/** Deterministic fixture identity, `demoId(namespace, key)` from scripts/demo/fixture-ids.mts. */
export type DemoId = (namespace: string, key: string) => string;
const productUnitOf = (unit: string): AkrosEncodedState['products'][number]['unit'] =>
  unit === 'm' || unit === 'tab' || unit === 'set' ? unit : 'ks';
const at = '2026-10-19T08:00:00.000Z';
const vatRate: VatRate = 21;
type SourceCatalogFields = {
  -readonly [
    Key in 'minimumQuantity' | 'packageQuantity' | 'parameters' | 'priceTiers' | 'sourceUnit'
  ]?: AkrosEncodedState['products'][number][Key];
};
const fieldsFor = (
  source: Pick<SourceProduct, 'minimumQuantity' | 'packageQuantity' | 'unit'> & {
    readonly parameters: readonly (typeof ParameterSchema.Type)[];
    readonly priceTiers: readonly (typeof TierSchema.Type)[];
  },
) => {
  const packageFields: Pick<SourceCatalogFields, 'packageQuantity'> = {};
  if (source.packageQuantity !== undefined) {
    packageFields.packageQuantity = source.packageQuantity;
  }
  return {
    minimumQuantity: source.minimumQuantity,
    ...packageFields,
    parameters: source.parameters.map(parameterForBaseline),
    priceTiers: source.priceTiers,
    sourceUnit: source.unit,
  };
};
/** Feed root branches AKROS keeps out of the storefront navigation (internal „Mimo menu“, UNC thread nuts). */
export const AKROS_HIDDEN_CATEGORY_IDS: ReadonlySet<string> = new Set(['322', '3504']);

/** Catalogue-only groups are not replenished. Stocked groups keep a small, unit-aware reserve. */
export const akrosMinimumStock = (stock: number): number =>
  stock <= 0 ? 0 : Math.min(100, Math.max(1, Math.floor(stock / 5)));

export const buildAkrosEncodedFrom = Effect.fn('Akros.buildEncodedBaseline')(function* buildEncodedBaseline(
  source: AkrosSource,
  demoId: DemoId,
): Effect.fn.Return<AkrosEncodedState, Schema.SchemaError> {
  const { catalog, categories } = source;
  // Import every source group; never silently curate the live owner catalog.
  const akrosSourceProducts = catalog.products;
  const byCategory = new Map<string, Category>(categories.map((category) => [category.id, category]));
  const pathFor = (id: string): string[] => {
    const path: string[] = [];
    let next: string | null = id;
    while (next !== null && !path.includes(next)) {
      path.push(next);
      const parent: Category['parentId'] | undefined = byCategory.get(next)?.parentId;
      next = parent === undefined ? null : Option.getOrNull(parent);
    }
    return path;
  };
  const sourceProducts: AkrosEncodedState['products'] = akrosSourceProducts.map((product) => ({
    ...fieldsFor({ ...product, ...product.detail }),
    active: true,
    category: byCategory.get(product.categoryId)?.name ?? 'Spojovací materiál',
    categoryId: product.categoryId,
    categoryPathIds: pathFor(product.categoryId),
    createdAt: at,
    currentPriceMinor: product.detail.priceTiers[0]?.priceExcludingVatMinor ?? Math.round(product.priceMinor / 1.21),
    description: stripUnbackedDiscount(product.detail.descriptionParagraphs.join('\n\n') || product.description),
    featuredPosition: Option.getOrNull(product.featuredPosition),
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
    variants: product.detail.variants.map((variant) => {
      const identity = Object.assign(fieldsFor(variant), { unit: variant.unit }, { id: variant.id });
      const sourceIdentity = Object.assign(identity, { sourceId: variant.sourceId }, { sku: variant.sku });
      const description = Object.assign(
        sourceIdentity,
        { name: variant.label },
        {
          active: true,
          attributes: variant.parameters
            .map((parameter) => `${parameter.label}: ${parameter.value} ${parameter.unit}`)
            .join('; ')
            .slice(0, 1000),
          imageSrc: variant.imageSrc ?? product.imageSrc,
        },
      );
      const price = Object.assign(
        description,
        { priceMinor: variant.priceTiers[0]?.priceExcludingVatMinor ?? Math.round(variant.priceMinor / 1.21) },
        { priceHistory: [] },
      );
      return Object.assign(
        price,
        { isAction: variant.isAction, isRecommended: variant.isRecommended, isSale: variant.isSale },
        { isNew: variant.isNew },
      );
    }),
    vatRate,
  }));
  const products = sourceProducts.map(applyDemoPriceTiers);
  const movements: AkrosEncodedState['movements'] = akrosSourceProducts.flatMap((product) => {
    const units: readonly BaselineStockSource[] =
      product.detail.variants.length > 0 ? product.detail.variants : [{ stockCount: product.stockCount }];
    return units
      .filter((unit) => unit.stockCount !== 0)
      .map((unit) => {
        const identity: { -readonly [Key in keyof BaselineMovementIdentity]: BaselineMovementIdentity[Key] } = {
          id: demoId('akros.receipt', unit.id ?? product.id),
          productId: product.id,
        };
        if (unit.id !== undefined) {
          identity.variantId = unit.id;
        }
        return {
          ...identity,
          at,
          delta: unit.stockCount,
          note: 'Výchozí sklad AKROS (demo)',
          reason: 'RECEIPT' as const,
        };
      });
  });
  const statuses = ['NEW', 'CONFIRMED', 'PACKING', 'SHIPPED', 'DELIVERED', 'CANCELLED'] as const;
  const orders: AkrosEncodedState['orders'] = yield* Effect.forEach(
    statuses,
    Effect.fn(function* buildSampleOrder(
      status: (typeof statuses)[number],
      index: number,
    ): Effect.fn.Return<AkrosEncodedState['orders'][number], Schema.SchemaError> {
      const sampleProduct =
        akrosSourceProducts.find(
          (product, position) =>
            position >= index &&
            product.detail.variants.some((variant) => variant.stockCount >= variant.minimumQuantity),
        ) ?? akrosSourceProducts[0];
      const variant =
        sampleProduct.detail.variants.find((entry) => entry.stockCount >= entry.minimumQuantity) ??
        (yield* Schema.decodeUnknownEffect(VariantSchema)(sampleProduct.detail.variants[0]));
      const quantity =
        variant.packageQuantity === undefined
          ? Math.max(variant.minimumQuantity, 1)
          : Math.ceil(Math.max(variant.minimumQuantity, 1) / variant.packageQuantity) * variant.packageQuantity;
      const tier = variant.priceTiers.findLast((entry) => entry.minimumQuantity <= quantity) ?? variant.priceTiers[0];
      const totalMinor = Math.round(quantity * tier.priceMinor);
      const contact = yield* Schema.decodeUnknownEffect(Schema.Struct({ email: Schema.String, name: Schema.String }))(
        akrosSampleContacts[index],
      );
      const contactFields = { name: contact.name };
      const deliveryAddress = { city: 'Brno', postalCode: '602 00', street: 'Ukázková 12' };
      const createdHistory = { kind: 'CREATED' as const };
      const lineIdentity = { productId: sampleProduct.id, productName: sampleProduct.name };
      const lineVariant = Object.assign(
        lineIdentity,
        { variantId: variant.id, variantName: variant.label },
        { sku: variant.sku },
      );
      const shippingMethod = { method: 'OSOBNI_ODBER' as const };
      return {
        channel: 'STOREFRONT',
        clientRequestId: `akros-sample-order-${index}`,
        contact: Object.assign(contactFields, { email: contact.email }),
        createdAt: at,
        deliveryAddress: Object.assign(deliveryAddress, { country: 'CZ' }),
        demo: true,
        history: [Object.assign(createdHistory, { at }, { actorLabel: 'Zákazník – AKROS (DEMO)', after: status })],
        id: demoId('akros.order', String(index)),
        lines: [
          {
            ...lineVariant,
            quantity,
            unitPriceMinor: tier.priceMinor,
            vatRate,
          },
        ],
        number: `OBJ-2026-${String(index + 1).padStart(4, '0')}`,
        partyId: 'storefront-guest',
        pricesIncludeVat: true,
        shipping: Object.assign(shippingMethod, { label: 'Osobní odběr – AKROS (simulace)', priceMinor: 0, vatRate }),
        status,
        totalMinor,
        totalVatMinor: totalMinor - Math.round(totalMinor / 1.21),
        updatedAt: at,
      };
    }),
    { concurrency: 1 },
  );
  return {
    categories: orderCategoryPositions(
      categories
        .map((category) => decodeCategoryText(category))
        .map((category) => {
          const result: NonNullable<AkrosEncodedState['categories']>[number] = {
            ...category,
            description: category.description ?? '',
            hasChildren: category.hasChildren ?? false,
            heading: category.heading ?? category.name,
            imageAlt: category.imageAlt ?? category.name,
            imageSrc: category.imageSrc ?? '',
            longDescription: category.longDescription ?? '',
            parentId: Option.getOrNull(category.parentId),
            position: category.position ?? 0,
          };
          if (AKROS_HIDDEN_CATEGORY_IDS.has(category.id)) {
            return { ...result, published: false };
          }
          return result;
        }),
    ),
    homepageFeaturedProductIds: catalog.homepageFeaturedProductIds,
    movements,
    orders,
    products,
  };
});
