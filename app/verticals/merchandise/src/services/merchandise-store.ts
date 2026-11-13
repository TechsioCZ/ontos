import { agentHistoryPageSql } from '@app/core-runtime/db/agent-history-page';
import type { AgentHistoryRequest } from '@app/shared-contracts/agent-proposals';
// Row mapping between the merchandise domain values and the normalized tables (src/database/schema.ts), plus the
// three write paths: replace a company snapshot (seeds, demo reset), load a command's working set, and persist
// only the rows a command changed. Bounded reads live in merchandise-queries.ts.
import type { ReadServiceFactory } from '@app/core-runtime';
import { and, asc, desc, eq, inArray, isNotNull, isNull, like, notInArray, or, sql } from 'drizzle-orm';
import type { SQL } from 'drizzle-orm';
import type { AnyPgColumn } from 'drizzle-orm/pg-core';
import { Data, DateTime, Effect, Option, Ref, Schema } from 'effect';
import type { MerchandiseAiSlice, MerchandiseState } from '../../shared/apis/records.ts';
import { MerchandiseAiSliceSchema } from '../../shared/apis/records.ts';
import {
  CatalogCategorySchema,
  CatalogChangeSchema,
  OrderSchema,
  ProductSchema,
  ProductIdReferenceSchema,
  ProductVariantSchema,
  StockMovementSchema,
  grossUnitPriceMinor,
} from '../../shared/domain/merchandise-model.ts';
import type { CatalogCategory, Order, Product, StockMovement } from '../../shared/domain/merchandise-model.ts';
import { ORDER_NUMBER_PREFIX } from '../../shared/domain/order-totals.ts';
import {
  catalogHeads,
  categories,
  orders,
  priceTiers,
  productVariants,
  products,
  stockMovements,
} from '../database/schema.ts';
import { grossPriceOf, productRateOf, realVariantsOf, stockLevelsOf, toProductRecord } from './stock-levels.ts';
import type { StockLevels } from './stock-levels.ts';
import { CompanyTaxRatesSchema, heldRatesOf, sellableRatesOf } from './tax-rates.ts';
import type { CompanyTaxRates, HeldProductRates, SellableVatRates } from './tax-rates.ts';
import { normalizeSearchText } from './storefront-catalog.ts';
import {
  CZ_VAT_REDUCED,
  CZ_VAT_STANDARD,
  czVatClassificationCodes,
} from '@app/shared-contracts/cz-vat-classifications';
import type { CzVatClassificationCode } from '@app/shared-contracts/cz-vat-classifications';

export class MerchandiseStoreFailure extends Data.TaggedError('MerchandiseStoreFailure')<{
  readonly cause?: unknown;
  readonly reason: string;
}> {}

type ScopedTransaction = Parameters<ReadServiceFactory<Readonly<Record<string, never>>>>[0];
export type MerchandiseDb = Pick<ScopedTransaction, 'delete' | 'insert' | 'select' | 'update'>;

export interface StoreScope {
  readonly legalEntityId: string;
  readonly tenantId: string;
}

/** Every statement's failure becomes one store failure; persistence reports it as temporarily unavailable. */
export const query = <A, E, R>(effect: Effect.Effect<A, E, R>, reason = 'Merchandise query failed') =>
  effect.pipe(Effect.mapError((cause) => new MerchandiseStoreFailure({ cause, reason })));

const attempt = <A>(reason: string, run: () => A) =>
  Effect.try({ catch: (cause) => new MerchandiseStoreFailure({ cause, reason }), try: run });

const encodeProduct = Schema.encodeEffect(ProductSchema);
const decodeProduct = Schema.decodeUnknownEffect(ProductSchema);
const encodeOrder = Schema.encodeEffect(OrderSchema);
const decodeOrder = Schema.decodeUnknownEffect(OrderSchema);
const decodeMovement = Schema.decodeUnknownEffect(StockMovementSchema);
const encodeCategoryHistory = Schema.encodeEffect(Schema.Array(CatalogChangeSchema));
const decodeCategory = Schema.decodeUnknownEffect(CatalogCategorySchema);
const encodeSlice = Schema.encodeEffect(MerchandiseAiSliceSchema);
const decodeSlice = Schema.decodeUnknownEffect(
  Schema.OptionFromNullishOr(MerchandiseAiSliceSchema, { onNoneEncoding: null }),
);
const {
  priceTiers: productTiersSchema,
  variants: productVariantsSchema,
  ...storedProductFields
} = ProductSchema.fields;
const productDocumentSchema = Schema.toEncoded(Schema.Struct(storedProductFields));
const productDocumentWithTiersSchema = Schema.toEncoded(
  Schema.Struct({ ...storedProductFields, priceTiers: productTiersSchema }),
);
const productDocumentWithVariantsSchema = Schema.toEncoded(
  Schema.Struct({ ...storedProductFields, variants: productVariantsSchema }),
);
const { priceTiers: _variantTiersSchema, ...storedVariantFields } = ProductVariantSchema.fields;
void _variantTiersSchema;
const variantDocumentSchema = Schema.toEncoded(Schema.Struct(storedVariantFields));
const fullProductDocumentSchema = Schema.toEncoded(ProductSchema);
const fullVariantDocumentSchema = Schema.toEncoded(ProductVariantSchema);

export const whereScope = (
  table: { readonly legalEntityId: AnyPgColumn; readonly tenantId: AnyPgColumn },
  scope: StoreScope,
) => and(eq(table.tenantId, scope.tenantId), eq(table.legalEntityId, scope.legalEntityId));

const inBatches = <T>(items: readonly T[], size: number): readonly (readonly T[])[] => {
  const batches: T[][] = [];
  for (let index = 0; index < items.length; index += size) {
    batches.push(items.slice(index, index + size));
  }
  return batches;
};

const date = (value: DateTime.Utc) => DateTime.toDateUtc(value);
export const skuKeyOf = (sku: string) => sku.trim().toLowerCase();

const parameterText = (parameters: Product['parameters']) =>
  (parameters ?? []).map(({ label, unit, value }) => `${label} ${value} ${unit}`);

/** Folded product text and active variant text; unset activity means active, just like the stored variant rows. */
export const productSearchText = (
  product: Pick<Product, 'name' | 'parameters' | 'shortDescription' | 'sku' | 'variants'>,
) =>
  normalizeSearchText(
    [
      product.name,
      product.sku,
      product.shortDescription ?? '',
      ...parameterText(product.parameters),
      ...(product.variants ?? []).flatMap((variant) =>
        variant.active === false
          ? []
          : [variant.name, variant.sku ?? '', variant.attributes, ...parameterText(variant.parameters)],
      ),
    ].join(' '),
  );

const hasPhoto = (product: Product) => {
  const image = product.images?.[0] ?? product.imageSrc;
  return image !== undefined && image !== '' && !image.includes('image-unavailable.svg');
};

/** Products kept at the rate they were migrated with, by product id (`heldProductRates`). */
type HeldRates = HeldProductRates;
type ProductRow = typeof products.$inferInsert;
type VariantRow = typeof productVariants.$inferInsert;
type TierRow = typeof priceTiers.$inferInsert;

/** Derived projection columns of one product at the given stock. */
const derivedColumns = (product: Product, stock: StockLevels, rates: SellableVatRates, held: HeldRates) => {
  const record = toProductRecord(product, stock, rates, held);
  return {
    availability: record.availability ?? 'UNKNOWN',
    grossPriceMinor: record.grossPriceMinor ?? null,
    lowStock: record.lowStock,
    stockOnHand: record.stockOnHand,
    stockValueMinor: record.stockValueMinor,
  };
};

const tierRowsOf = (
  scope: StoreScope,
  productId: string,
  variantPosition: number,
  tiers: Product['priceTiers'],
): TierRow[] =>
  (tiers ?? []).map((tier, position) => ({
    ...scope,
    minimumQuantity: tier.minimumQuantity,
    position,
    priceExcludingVatMinor: tier.priceExcludingVatMinor,
    priceMinor: tier.priceMinor,
    productId,
    variantPosition,
  }));

/** The rates the release before classifications may read for a classification, lowest first: the migration's mapping. */
const ROLLBACK_RATES = { [CZ_VAT_REDUCED]: [10, 12], [CZ_VAT_STANDARD]: [21] } as const;

/**
 * Every price the release before classifications computes from the document's `vatRate`, with what this release
 * charges for it now: each real variant, or the product itself when it has none. That release sells a tiered price at
 * its first tier on the storefront, but a line staff add to a VAT-inclusive order it prices from net + `vatRate`,
 * ignoring tiers; this release charges the first tier's price for both (`storedGrossOf`). So a tiered price counts too,
 * compared with its first tier.
 */
const recomputedPricesOf = (product: Product, rate: number | undefined) => {
  const variants = realVariantsOf(product);
  const entries =
    variants.length > 0
      ? variants.map((variant) => ({ net: variant.priceMinor, priced: variant }))
      : [{ net: product.currentPriceMinor, priced: product }];
  return entries.flatMap(({ net, priced }) => {
    const charged = grossPriceOf(priced, net, rate);
    return charged === undefined ? [] : [{ charged, net }];
  });
};

/**
 * The rate the release before classifications reads in a product document, until the contract step strips it: that
 * release requires a `vatRate` and computes prices from it. This release never reads it, and the expand step's triggers
 * never read it from this release's writes (they act only on documents without `taxClassificationCode`, which only the
 * old release writes). So it is chosen for one purpose, money after a rollback: of the rates the product's current
 * classification admits (reduced: 10 or 12 %, standard: 21 %), the highest at which every price the old release would
 * compute is at most what this release charges now, so nobody pays more after a rollback; when there is none, the
 * lowest. A held product sells at 10 %, so it writes 10 and a rollback keeps it held there.
 */
export const rollbackVatRateOf = (product: Product, rates: SellableVatRates, held: HeldRates): number => {
  const candidates: readonly number[] = ROLLBACK_RATES[product.taxClassificationCode];
  const prices = recomputedPricesOf(product, productRateOf(product, rates, held));
  const neverHigher = (rate: number) => prices.every(({ charged, net }) => grossUnitPriceMinor(net, rate) <= charged);
  return candidates.toReversed().find(neverHigher) ?? Math.min(...candidates);
};

/** Product row, its variant rows and its price-tier rows. Documents never repeat variants or tiers. */
export const productRowsOf = Effect.fn('MerchandiseStore.productRowsOf')(function* encodeProductRows(
  scope: StoreScope,
  product: Product,
  stock: StockLevels,
  rates: SellableVatRates,
  held: HeldRates,
) {
  const rate = productRateOf(product, rates, held);
  const encoded = yield* encodeProduct(product);
  const { priceTiers: _tiers, variants: encodedVariants, ...document } = encoded;
  void _tiers;
  const row: ProductRow = {
    ...scope,
    ...derivedColumns(product, stock, rates, held),
    active: product.active,
    archived: product.demoArchive !== undefined,
    category: product.category,
    categoryId: product.categoryId ?? null,
    categoryPathIds: [...(product.categoryPathIds ?? [])],
    createdAt: date(product.createdAt),
    currentPriceMinor: product.currentPriceMinor,
    document: { ...document, vatRate: rollbackVatRateOf(product, rates, held) },
    featuredPosition: product.featuredPosition === undefined ? null : Option.getOrNull(product.featuredPosition),
    hasPhoto: hasPhoto(product),
    id: product.id,
    isAction: product.isAction === true,
    isNew: product.isNew === true,
    isRecommended: product.isRecommended === true,
    isSale: product.isSale === true,
    name: product.name,
    nameKey: normalizeSearchText(product.name),
    published: product.published !== false,
    searchText: productSearchText(product),
    sku: product.sku,
    skuKey: skuKeyOf(product.sku),
    slug: product.slug ?? null,
    sourceGroupId: product.sourceGroupId ?? null,
    taxClassificationCode: product.taxClassificationCode,
    updatedAt: date(product.updatedAt),
  };
  const variants: VariantRow[] = (product.variants ?? []).map((variant, position) => {
    const { priceTiers: _variantTiers, ...variantDocument } = encodedVariants?.[position] ?? {};
    void _variantTiers;
    return {
      ...scope,
      active: variant.active !== false,
      document: variantDocument,
      grossPriceMinor:
        variant.priceMinor === undefined ? null : (grossPriceOf(variant, variant.priceMinor, rate) ?? null),
      name: variant.name,
      position,
      priceMinor: variant.priceMinor ?? null,
      productId: product.id,
      sku: variant.sku ?? null,
      stockOnHand: variant.id === undefined ? 0 : (stock.variants.get(variant.id) ?? 0),
      unit: variant.unit ?? variant.sourceUnit ?? product.unit,
      variantId: variant.id ?? null,
    };
  });
  const tiers = [
    ...tierRowsOf(scope, product.id, -1, product.priceTiers),
    ...(product.variants ?? []).flatMap((variant, position) =>
      tierRowsOf(scope, product.id, position, variant.priceTiers),
    ),
  ];
  return { row, tiers, variants };
});

type StoredProduct = Pick<typeof products.$inferSelect, 'document' | 'grossPriceMinor' | 'id' | 'stockOnHand'>;
type StoredVariant = Pick<
  typeof productVariants.$inferSelect,
  'document' | 'grossPriceMinor' | 'position' | 'productId' | 'stockOnHand' | 'variantId'
>;
type StoredTier = Pick<
  typeof priceTiers.$inferSelect,
  'minimumQuantity' | 'position' | 'priceExcludingVatMinor' | 'priceMinor' | 'productId' | 'variantPosition'
>;

const tierValue = (tier: StoredTier) => ({
  minimumQuantity: tier.minimumQuantity,
  priceExcludingVatMinor: tier.priceExcludingVatMinor,
  priceMinor: tier.priceMinor,
});

export interface HydratedProduct {
  readonly product: Product;
  readonly stock: StockLevels;
}

const tiersFor = (tiers: ReadonlyMap<string, readonly StoredTier[]>, productId: string, position: number) =>
  (tiers.get(`${productId}|${position}`) ?? []).toSorted((a, b) => a.position - b.position).map(tierValue);

// Relational rows replace only the document fields they own. Without replacement rows, legacy inline arrays remain.
const decodeStoredProduct = (row: StoredProduct, keepVariants: boolean, keepTiers: boolean) => {
  if (keepVariants) {
    return keepTiers
      ? Schema.decodeUnknownEffect(fullProductDocumentSchema)(row.document)
      : Schema.decodeUnknownEffect(productDocumentWithVariantsSchema)(row.document);
  }
  return keepTiers
    ? Schema.decodeUnknownEffect(productDocumentWithTiersSchema)(row.document)
    : Schema.decodeUnknownEffect(productDocumentSchema)(row.document);
};
const hydrateStoredVariant = Effect.fn('MerchandiseStore.hydrateVariant')(function* hydrateVariant(
  variant: StoredVariant,
  tiers: ReadonlyMap<string, readonly StoredTier[]>,
) {
  const variantTiers = tiersFor(tiers, variant.productId, variant.position);
  const decoded = yield* Schema.decodeUnknownEffect(
    variantTiers.length === 0 ? fullVariantDocumentSchema : variantDocumentSchema,
  )(variant.document);
  // The stored gross column is the variant's price as it was entered; documents written before stored gross carry it
  // only there.
  const document =
    decoded.grossPriceMinor === undefined && variant.grossPriceMinor !== null
      ? { ...decoded, grossPriceMinor: variant.grossPriceMinor }
      : decoded;
  return variantTiers.length === 0 ? document : { ...document, priceTiers: variantTiers };
});
const hydrateStoredProduct = Effect.fn('MerchandiseStore.hydrateProduct')(function* hydrateProduct(
  row: StoredProduct,
  variantRows: ReadonlyMap<string, readonly StoredVariant[]>,
  tiers: ReadonlyMap<string, readonly StoredTier[]>,
) {
  const variants = (variantRows.get(row.id) ?? []).toSorted((a, b) => a.position - b.position);
  const productTiers = tiersFor(tiers, row.id, -1);
  const decoded = yield* decodeStoredProduct(row, variants.length === 0, productTiers.length === 0);
  // A product without real variants: its stored gross column is its price as entered (with real variants the column
  // is their lowest price, never the product's own).
  const stored =
    decoded.grossPriceMinor === undefined &&
    row.grossPriceMinor !== null &&
    !variants.some((variant) => variant.variantId !== null)
      ? { ...decoded, grossPriceMinor: row.grossPriceMinor }
      : decoded;
  const document = productTiers.length === 0 ? stored : { ...stored, priceTiers: productTiers };
  const variantDocuments =
    variants.length === 0
      ? document
      : {
          ...document,
          variants: yield* Effect.forEach(variants, (variant) => hydrateStoredVariant(variant, tiers), {
            concurrency: 1,
          }),
        };
  const product = yield* decodeProduct(variantDocuments);
  const levels = new Map<string, number>();
  for (const variant of variants) {
    if (variant.variantId !== null) {
      levels.set(variant.variantId, variant.stockOnHand);
    }
  }
  return { product, stock: { total: row.stockOnHand, variants: levels } };
});

/** Products from their rows (variants/tiers grouped by product). Rows of other products are ignored. */
export const hydrateProducts = Effect.fn('MerchandiseStore.hydrateProducts')(function* hydrateProductRows(
  rows: readonly StoredProduct[],
  variantRows: readonly StoredVariant[],
  tierRows: readonly StoredTier[],
): Effect.fn.Return<readonly HydratedProduct[], Schema.SchemaError> {
  const variantsOf = new Map<string, StoredVariant[]>();
  for (const variant of variantRows) {
    const bucket = variantsOf.get(variant.productId) ?? [];
    bucket.push(variant);
    variantsOf.set(variant.productId, bucket);
  }
  const tiersOf = new Map<string, StoredTier[]>();
  for (const tier of tierRows) {
    const key = `${tier.productId}|${tier.variantPosition}`;
    const bucket = tiersOf.get(key) ?? [];
    bucket.push(tier);
    tiersOf.set(key, bucket);
  }
  return yield* Effect.forEach(rows, (row) => hydrateStoredProduct(row, variantsOf, tiersOf), { concurrency: 1 });
});

type OrderRow = typeof orders.$inferInsert;

const orderSearchText = (order: Order) =>
  normalizeSearchText(
    [order.number, order.contact?.name ?? '', order.contact?.email ?? '', order.contact?.phone ?? ''].join(' '),
  );

export const orderRowOf = Effect.fn('MerchandiseStore.orderRowOf')(function* encodeOrderRow(
  scope: StoreScope,
  order: Order,
) {
  return {
    ...scope,
    channel: order.channel ?? null,
    clientRequestId: order.clientRequestId ?? null,
    createdAt: date(order.createdAt),
    document: yield* encodeOrder(order),
    id: order.id,
    number: order.number,
    opportunityId: order.opportunityId ?? null,
    partyId: order.partyId,
    removed: order.demoCleanup !== undefined,
    searchText: orderSearchText(order),
    status: order.status,
    totalMinor: order.totalMinor,
    updatedAt: date(order.updatedAt),
  } satisfies OrderRow;
});

export const decodeOrderDocument = decodeOrder;

type CategoryRow = typeof categories.$inferInsert;

export const categoryRowOf = Effect.fn('MerchandiseStore.categoryRowOf')(function* encodeCategoryRow(
  scope: StoreScope,
  category: CatalogCategory,
) {
  return {
    ...scope,
    description: category.description,
    hasChildren: category.hasChildren,
    heading: category.heading,
    history: category.history === undefined ? null : yield* encodeCategoryHistory(category.history),
    id: category.id,
    imageAlt: category.imageAlt,
    imageSrc: category.imageSrc,
    longDescription: category.longDescription,
    name: category.name,
    parentId: Option.getOrNull(category.parentId),
    position: category.position,
    published: category.published ?? null,
    slug: category.slug,
  } satisfies CategoryRow;
});

export const decodeCategoryRow = (row: typeof categories.$inferSelect) => {
  const document = {
    description: row.description,
    hasChildren: row.hasChildren,
    heading: row.heading,
    id: row.id,
    imageAlt: row.imageAlt,
    imageSrc: row.imageSrc,
    longDescription: row.longDescription,
    name: row.name,
    parentId: row.parentId,
    position: row.position,
    slug: row.slug,
  };
  const published = row.published === null ? document : { ...document, published: row.published };
  return decodeCategory(row.history === null ? published : { ...published, history: row.history });
};

type MovementRow = typeof stockMovements.$inferInsert;

export const movementRowOf = (scope: StoreScope, movement: StockMovement): MovementRow => ({
  ...scope,
  at: date(movement.at),
  delta: movement.delta,
  id: movement.id,
  note: movement.note ?? null,
  productId: movement.productId,
  reason: movement.reason,
  reference: movement.reference ?? null,
  variantId: movement.variantId ?? null,
});

export const decodeMovementRow = (row: typeof stockMovements.$inferSelect) => {
  const document = {
    at: row.at.toISOString(),
    delta: row.delta,
    id: row.id,
    productId: row.productId,
    reason: row.reason,
  };
  const note = row.note === null ? document : { ...document, note: row.note };
  const reference = row.reference === null ? note : { ...note, reference: row.reference };
  return decodeMovement(row.variantId === null ? reference : { ...reference, variantId: row.variantId });
};

export const decodeAiSlice = (value: (typeof catalogHeads.$inferSelect)['aiChanges']) =>
  decodeSlice(value).pipe(Effect.map(Option.getOrUndefined));

// ------------------------------------------------------------------------------------------------ writes

type ProductRows = Effect.Success<ReturnType<typeof productRowsOf>>;
const writeBatches = <A, B, E, R>(
  rows: readonly A[],
  size: number,
  write: (batch: readonly A[]) => Effect.Effect<B, E, R>,
) => Effect.forEach(inBatches(rows, size), write, { concurrency: 1, discard: true });
const insertProductRows = Effect.fn('MerchandiseStore.insertProductRows')(function* writeProductRows(
  db: MerchandiseDb,
  rows: readonly ProductRows[],
) {
  yield* writeBatches(
    rows.map((entry) => entry.row),
    400,
    (batch) => query(db.insert(products).values([...batch]), 'Products could not be written'),
  );
  yield* writeBatches(
    rows.flatMap((entry) => entry.variants),
    1500,
    (batch) => query(db.insert(productVariants).values([...batch]), 'Variants could not be written'),
  );
  yield* writeBatches(
    rows.flatMap((entry) => entry.tiers),
    2500,
    (batch) => query(db.insert(priceTiers).values([...batch]), 'Price tiers could not be written'),
  );
});

/** Deletes every merchandise row of the company except its head row (seeds, demo reset). */
export const deleteScope = Effect.fn('MerchandiseStore.deleteScope')(function* deleteCompanyRows(
  db: MerchandiseDb,
  scope: StoreScope,
) {
  yield* query(db.delete(priceTiers).where(whereScope(priceTiers, scope)));
  yield* query(db.delete(productVariants).where(whereScope(productVariants, scope)));
  yield* query(db.delete(products).where(whereScope(products, scope)));
  yield* query(db.delete(stockMovements).where(whereScope(stockMovements, scope)));
  yield* query(db.delete(orders).where(whereScope(orders, scope)));
  yield* query(db.delete(categories).where(whereScope(categories, scope)));
});

/**
 * Inserts `part` in batched statements: its categories, products (stock derived from the part's movements, so a
 * part must carry every movement of its products), movements and orders. Rows insert in the part's order.
 */
export const insertSnapshotPart = Effect.fn('MerchandiseStore.insertSnapshotPart')(function* insertSnapshotPart(
  db: MerchandiseDb,
  scope: StoreScope,
  part: MerchandiseState,
  rates: SellableVatRates,
  held: HeldRates,
) {
  const byProduct = new Map<string, StockMovement[]>();
  for (const movement of part.movements) {
    const bucket = byProduct.get(movement.productId) ?? [];
    bucket.push(movement);
    byProduct.set(movement.productId, bucket);
  }
  const rows = yield* query(
    Effect.gen(function* encodeSnapshotRows() {
      const categoryRows = yield* Effect.forEach(part.categories ?? [], (category) => categoryRowOf(scope, category), {
        concurrency: 1,
      });
      const movementRows = part.movements.map((movement) => movementRowOf(scope, movement));
      const orderRows = yield* Effect.forEach(part.orders, (order) => orderRowOf(scope, order), { concurrency: 1 });
      const productRows = yield* Effect.forEach(
        part.products,
        (product) =>
          productRowsOf(scope, product, stockLevelsOf(byProduct.get(product.id) ?? [], product.id), rates, held),
        { concurrency: 1 },
      );
      return { categories: categoryRows, movements: movementRows, orders: orderRows, products: productRows };
    }),
    'Snapshot does not encode',
  );
  yield* writeBatches(rows.categories, 800, (batch) =>
    query(db.insert(categories).values([...batch]), 'Categories could not be written'),
  );
  yield* insertProductRows(db, rows.products);
  yield* writeBatches(rows.movements, 2500, (batch) =>
    query(db.insert(stockMovements).values([...batch]), 'Stock movements could not be written'),
  );
  yield* writeBatches(rows.orders, 400, (batch) =>
    query(db.insert(orders).values([...batch]), 'Orders could not be written'),
  );
});

/**
 * Writes the company's head row after a replace: homepage selection and AI slice. The head row keeps existing and
 * its revision advances, so open editors see a conflict, never stale data. Returns the new revision.
 */
export const writeSnapshotHead = Effect.fn('MerchandiseStore.writeSnapshotHead')(function* writeSnapshotHead(
  db: MerchandiseDb,
  scope: StoreScope,
  head: Pick<MerchandiseState, 'aiChanges' | 'homepageFeaturedProductIds'>,
) {
  const slice =
    head.aiChanges === undefined ? null : yield* query(encodeSlice(head.aiChanges), 'Snapshot does not encode');
  const now = DateTime.toDateUtc(yield* DateTime.now);
  const featured = [...(head.homepageFeaturedProductIds ?? [])];
  const heads = yield* query(
    db
      .insert(catalogHeads)
      .values({ ...scope, aiChanges: slice, homepageFeaturedProductIds: featured, revision: 0, updatedAt: now })
      .onConflictDoUpdate({
        set: {
          aiChanges: slice,
          homepageFeaturedProductIds: featured,
          revision: sql`${catalogHeads.revision} + 1`,
          updatedAt: now,
        },
        target: [catalogHeads.tenantId, catalogHeads.legalEntityId],
      })
      .returning({ revision: catalogHeads.revision }),
  );
  return heads[0]?.revision ?? 0;
});

/** The stored `tax_rates` document, decoded; null before the company's first sync. */
const decodeTaxRates = (value: (typeof catalogHeads.$inferSelect)['taxRates']) =>
  value === null
    ? Effect.succeed(Option.getOrUndefined(Option.none<CompanyTaxRates>()))
    : query(Schema.decodeUnknownEffect(CompanyTaxRatesSchema)(value), 'Company tax rates do not decode');

/** The rates prices are entered at: each classification's rate now, and the products held at their own rate. */
export interface StorePricing {
  readonly held: HeldRates;
  readonly rates: SellableVatRates;
}

/** The rates the company sells at now, from its last sync with Tax (none before the first sync), and its holds. */
export const currentPricingOf = Effect.fn('MerchandiseStore.currentPricingOf')(function* currentPricingOf(
  db: MerchandiseDb,
  scope: StoreScope,
) {
  const rows = yield* query(
    db.select({ taxRates: catalogHeads.taxRates }).from(catalogHeads).where(whereScope(catalogHeads, scope)).limit(1),
    'Company tax rates could not be read',
  );
  const stored = yield* decodeTaxRates(rows[0]?.taxRates ?? null);
  return {
    held: heldRatesOf(stored),
    rates: sellableRatesOf(stored, yield* DateTime.now),
  } satisfies StorePricing;
});

/** Replaces the whole company's merchandise with `state` in batched inserts (seeds); returns the new revision. */
export const replaceSnapshot = Effect.fn('MerchandiseStore.replaceSnapshot')(function* replaceSnapshot(
  db: MerchandiseDb,
  scope: StoreScope,
  state: MerchandiseState,
  /** The rates new prices without a stored gross are derived at; by default the company's current rates. */
  pricingNow?: StorePricing,
) {
  const { held, rates } = pricingNow ?? (yield* currentPricingOf(db, scope));
  yield* deleteScope(db, scope);
  yield* insertSnapshotPart(db, scope, state, rates, held);
  return yield* writeSnapshotHead(db, scope, state);
});

// ------------------------------------------------------------------------------------------------ loading

const productColumns = {
  document: products.document,
  grossPriceMinor: products.grossPriceMinor,
  id: products.id,
  stockOnHand: products.stockOnHand,
};
const variantColumns = {
  document: productVariants.document,
  grossPriceMinor: productVariants.grossPriceMinor,
  position: productVariants.position,
  productId: productVariants.productId,
  stockOnHand: productVariants.stockOnHand,
  variantId: productVariants.variantId,
};
const tierColumns = {
  minimumQuantity: priceTiers.minimumQuantity,
  position: priceTiers.position,
  priceExcludingVatMinor: priceTiers.priceExcludingVatMinor,
  priceMinor: priceTiers.priceMinor,
  productId: priceTiers.productId,
  variantPosition: priceTiers.variantPosition,
};

/** Products matching `where` with their variants and tiers (at most `limit`), in catalog order. */
export const loadProducts = Effect.fn('MerchandiseStore.loadProducts')(function* loadProducts(
  db: MerchandiseDb,
  scope: StoreScope,
  where?: SQL,
  options: {
    readonly limit?: number;
    readonly offset?: number;
    readonly orderBy?: readonly SQL[];
    readonly variants?: boolean;
  } = {},
) {
  const base = db
    .select(productColumns)
    .from(products)
    .where(and(whereScope(products, scope), where))
    .orderBy(...(options.orderBy ?? [asc(products.ordinal)]));
  const rows = yield* query(
    options.limit === undefined ? base : base.limit(options.limit).offset(options.offset ?? 0),
    'Products could not be read',
  );
  if (rows.length === 0) {
    return [];
  }
  const ids = rows.map((row) => row.id);
  const variantRows =
    options.variants === false
      ? []
      : yield* query(
          db
            .select(variantColumns)
            .from(productVariants)
            .where(and(whereScope(productVariants, scope), inArray(productVariants.productId, ids))),
          'Variants could not be read',
        );
  const tierRows = yield* query(
    db
      .select(tierColumns)
      .from(priceTiers)
      .where(
        and(
          whereScope(priceTiers, scope),
          inArray(priceTiers.productId, ids),
          ...(options.variants === false ? [eq(priceTiers.variantPosition, -1)] : []),
        ),
      ),
    'Price tiers could not be read',
  );
  return yield* query(hydrateProducts(rows, variantRows, tierRows), 'Stored product does not decode');
});

export interface CatalogHead {
  readonly aiChanges: MerchandiseAiSlice | undefined;
  readonly homepageFeaturedProductIds: readonly (typeof ProductIdReferenceSchema.Type)[];
  readonly revision: number;
  /** The company's VAT rates as last synced from Tax; absent before the first sync. */
  readonly taxRates: CompanyTaxRates | undefined;
}

/**
 * A company whose head row was never written: no products, orders or AI changes yet. Reads answer it at revision 0;
 * the company's first write creates the row ({@link lockHeadForWrite}).
 */
export const EMPTY_CATALOG_HEAD: CatalogHead = Object.freeze({
  aiChanges: Option.getOrUndefined(Option.none<MerchandiseAiSlice>()),
  homepageFeaturedProductIds: [],
  revision: 0,
  taxRates: Option.getOrUndefined(Option.none<CompanyTaxRates>()),
});

const encodeTaxRates = Schema.encodeEffect(CompanyTaxRatesSchema);

/** Records a sync with Tax on the company's (locked) head row; the command's own write advances the revision. */
export const writeTaxRates = Effect.fn('MerchandiseStore.writeTaxRates')(function* writeTaxRates(
  db: MerchandiseDb,
  scope: StoreScope,
  value: CompanyTaxRates,
) {
  const encoded = yield* query(encodeTaxRates(value), 'Company tax rates do not encode');
  yield* query(
    db.update(catalogHeads).set({ taxRates: encoded }).where(whereScope(catalogHeads, scope)),
    'Company tax rates could not be written',
  );
});

/** The lowest stored gross of a product's real variants matching `which`, for an update of that product row. */
const lowestVariantGross = (which: SQL) =>
  sql`(select min(${productVariants.grossPriceMinor}) from ${productVariants}
    where ${productVariants.tenantId} = ${products.tenantId}
      and ${productVariants.legalEntityId} = ${products.legalEntityId}
      and ${productVariants.productId} = ${products.id}
      and ${productVariants.variantId} is not null
      and ${which})`;
const activeVariant = sql`${productVariants.active}`;
const anyVariant = sql`true`;

/** Net plus VAT in SQL, rounded exactly as `grossUnitPriceMinor` rounds it. */
const grossOfNet = (net: AnyPgColumn, rate: number) => sql<number>`${net} + (${net} * ${rate}::integer + 50) / 100`;

/**
 * Stores the first gross price of what was priced while its classification had no rate (nothing was stored then):
 * net plus VAT at the rate the classification has now. A stored gross is never touched; a product with real variants
 * takes the lowest gross of its active variants (of all of them when none is active), as its projection does.
 */
/** A product held at its stored rate until Tax first prices its company, by product id (BOOK-IT, 10 %). */

/**
 * The groups a missing gross is entered in, each with the rate it is entered at: a held product at its held rate, any
 * other product at the rate its classification sells at now (one with no usable rate is in no group).
 */
const pricedGroups = (db: MerchandiseDb, scope: StoreScope, rates: SellableVatRates, held: HeldRates) => {
  const heldIds = Object.keys(held);
  // A hold applies only to a reduced product (`heldRateOf`).
  const notHeldIn = (code: CzVatClassificationCode) =>
    heldIds.length === 0 || code !== CZ_VAT_REDUCED ? sql`true` : notInArray(products.id, heldIds);
  const byClassification = czVatClassificationCodes.flatMap((code) => {
    const rate = rates[code];
    const notHeld = notHeldIn(code);
    return rate === undefined
      ? []
      : [
          {
            ids: db
              .select({ id: products.id })
              .from(products)
              .where(and(whereScope(products, scope), eq(products.taxClassificationCode, code), notHeld)),
            rate,
          },
        ];
  });
  const byHeldRate = [...new Set(Object.values(held))].map((rate) => ({
    ids: db
      .select({ id: products.id })
      .from(products)
      .where(
        and(
          whereScope(products, scope),
          eq(products.taxClassificationCode, CZ_VAT_REDUCED),
          inArray(
            products.id,
            heldIds.filter((id) => held[id] === rate),
          ),
        ),
      ),
    rate,
  }));
  return [...byClassification, ...byHeldRate];
};

/** No gross stored for this price: neither in its column nor in its document (older documents carry it only there). */
const productGrossMissing = and(isNull(products.grossPriceMinor), sql`not (${products.document} ? 'grossPriceMinor')`);
const variantGrossMissing = and(
  isNull(productVariants.grossPriceMinor),
  sql`not (${productVariants.document} ? 'grossPriceMinor')`,
  isNotNull(productVariants.priceMinor),
);

/**
 * Whether any price that can be priced now is stored without its gross: one indexed probe per group, so callers run
 * {@link storeMissingGrossPrices} only when there is something to fill.
 */
export const missingGrossPricesExist = Effect.fn('MerchandiseStore.missingGrossPricesExist')(
  function* missingGrossPricesExist(
    db: MerchandiseDb,
    scope: StoreScope,
    rates: SellableVatRates,
    held: HeldRates = {},
  ) {
    const found = yield* Effect.forEach(
      pricedGroups(db, scope, rates, held),
      ({ ids }) =>
        Effect.all(
          [
            query(
              db
                .select({ id: products.id })
                .from(products)
                .where(and(whereScope(products, scope), inArray(products.id, ids), productGrossMissing))
                .limit(1),
              'Missing gross prices could not be read',
            ),
            query(
              db
                .select({ id: productVariants.productId })
                .from(productVariants)
                .where(
                  and(whereScope(productVariants, scope), inArray(productVariants.productId, ids), variantGrossMissing),
                )
                .limit(1),
              'Missing gross prices could not be read',
            ),
          ],
          { concurrency: 1 },
        ).pipe(Effect.map(([product, variant]) => product.length > 0 || variant.length > 0)),
      { concurrency: 1 },
    );
    return found.some(Boolean);
  },
);

/**
 * Stores the first gross of every price stored without one: product and variant prices with no gross in their column
 * nor in their document, at the rate their group enters it at (a held product at its held rate, any other at the rate
 * its classification sells at now), and a product with variants whose own gross is missing takes its variants' lowest.
 * Never touches a price that has a stored gross, however unrelated to its net. Idempotent; returns how many rows it
 * filled.
 */
export const storeMissingGrossPrices = Effect.fn('MerchandiseStore.storeMissingGrossPrices')(
  function* storeMissingGrossPrices(
    db: MerchandiseDb,
    scope: StoreScope,
    rates: SellableVatRates,
    held: HeldRates = {},
  ) {
    const realVariants = db
      .select({ productId: productVariants.productId })
      .from(productVariants)
      .where(and(whereScope(productVariants, scope), isNotNull(productVariants.variantId)));
    const filled = yield* Effect.forEach(
      pricedGroups(db, scope, rates, held),
      ({ ids, rate }) =>
        Effect.all(
          [
            query(
              db
                .update(productVariants)
                .set({ grossPriceMinor: grossOfNet(productVariants.priceMinor, rate) })
                .where(
                  and(whereScope(productVariants, scope), inArray(productVariants.productId, ids), variantGrossMissing),
                )
                .returning({ id: productVariants.productId }),
              'Variant gross prices could not be stored',
            ),
            query(
              db
                .update(products)
                .set({ grossPriceMinor: grossOfNet(products.currentPriceMinor, rate) })
                .where(
                  and(
                    whereScope(products, scope),
                    inArray(products.id, ids),
                    productGrossMissing,
                    notInArray(products.id, realVariants),
                  ),
                )
                .returning({ id: products.id }),
              'Product gross prices could not be stored',
            ),
            query(
              db
                .update(products)
                .set({
                  grossPriceMinor: sql`coalesce(${lowestVariantGross(activeVariant)}, ${lowestVariantGross(anyVariant)})`,
                })
                .where(
                  and(
                    whereScope(products, scope),
                    inArray(products.id, ids),
                    productGrossMissing,
                    inArray(products.id, realVariants),
                  ),
                )
                .returning({ id: products.id }),
              'Product gross prices could not be stored',
            ),
          ],
          { concurrency: 1 },
        ).pipe(Effect.map((rows) => rows.reduce((total, changed) => total + changed.length, 0))),
      { concurrency: 1 },
    );
    return filled.reduce((total, count) => total + count, 0);
  },
);

/** Advances the (locked) head revision of a write that changed only synced rates and prices; returns it. */
export const advanceHeadRevision = Effect.fn('MerchandiseStore.advanceHeadRevision')(function* advanceHeadRevision(
  db: MerchandiseDb,
  scope: StoreScope,
  revision: number,
  now: DateTime.Utc,
) {
  const heads = yield* query(
    db
      .update(catalogHeads)
      .set({ revision: revision + 1, updatedAt: date(now) })
      .where(and(whereScope(catalogHeads, scope), eq(catalogHeads.revision, revision)))
      .returning({ revision: catalogHeads.revision }),
    'Merchandise head could not be written',
  );
  return heads.length === 1 ? revision + 1 : undefined;
});

/**
 * A staff read's backfill of missing gross prices: runs {@link storeMissingGrossPrices} only when the head is still
 * at `revision` and no writer holds it (a read never waits; the next read retries), advancing the revision when it
 * filled anything. Returns the head's revision, or undefined when it did not run.
 */
export const storeMissingGrossPricesIfIdle = Effect.fn('MerchandiseStore.storeMissingGrossPricesIfIdle')(
  function* storeMissingGrossPricesIfIdle(
    db: MerchandiseDb,
    scope: StoreScope,
    revision: number,
    rates: SellableVatRates,
    held: HeldRates,
    now: DateTime.Utc,
  ) {
    const locked = yield* query(
      db
        .select({ revision: catalogHeads.revision })
        .from(catalogHeads)
        .where(and(whereScope(catalogHeads, scope), eq(catalogHeads.revision, revision)))
        .for('update', { skipLocked: true }),
      'Merchandise head could not be read',
    );
    if (locked.length !== 1) {
      return Option.getOrUndefined(Option.none<number>());
    }
    const filled = yield* storeMissingGrossPrices(db, scope, rates, held);
    if (filled === 0) {
      return revision;
    }
    return yield* advanceHeadRevision(db, scope, revision, now);
  },
);

/**
 * A read's materialisation of Tax's answer: records the rates (advancing the revision when they changed, not when Tax
 * only confirmed them again) in one statement, only when the head is still at `revision` and no writer holds it (a
 * read never waits for a writer; the next read retries). Returns the head's revision, or undefined when it did not run.
 */
export const materialiseTaxRatesIfIdle = Effect.fn('MerchandiseStore.materialiseTaxRatesIfIdle')(
  function* materialiseTaxRatesIfIdle(
    db: MerchandiseDb,
    scope: StoreScope,
    revision: number,
    value: CompanyTaxRates,
    now: DateTime.Utc,
    changed: boolean,
  ) {
    const encoded = yield* query(encodeTaxRates(value), 'Company tax rates do not encode');
    const next = changed ? revision + 1 : revision;
    const idle = sql`exists (select 1 from ${catalogHeads} as idle
      where idle.tenant_id = ${scope.tenantId}::uuid and idle.legal_entity_id = ${scope.legalEntityId}::uuid
        and idle.revision = ${revision} for update skip locked)`;
    const heads = yield* query(
      db
        .update(catalogHeads)
        .set(changed ? { revision: next, taxRates: encoded, updatedAt: date(now) } : { taxRates: encoded })
        .where(and(whereScope(catalogHeads, scope), eq(catalogHeads.revision, revision), idle))
        .returning({ revision: catalogHeads.revision }),
      'Company tax rates could not be written',
    );
    return heads.length === 1 ? next : undefined;
  },
);

/** The company's head row; `lock` serializes writers of the company (SELECT … FOR UPDATE). */
export const loadHead = Effect.fn('MerchandiseStore.loadHead')(function* loadHead(
  db: MerchandiseDb,
  scope: StoreScope,
  options: { readonly aiChanges?: boolean; readonly history?: AgentHistoryRequest; readonly lock?: boolean } = {},
): Effect.fn.Return<CatalogHead | undefined, MerchandiseStoreFailure> {
  const history =
    options.history === undefined
      ? catalogHeads.aiChanges
      : agentHistoryPageSql(catalogHeads.aiChanges, 'merchandise', options.history);
  const base = db
    .select({
      aiChanges: options.aiChanges === true ? history : sql<null>`null`,
      bootstrapCheckpoint: catalogHeads.bootstrapCheckpoint,
      homepageFeaturedProductIds: catalogHeads.homepageFeaturedProductIds,
      revision: catalogHeads.revision,
      taxRates: catalogHeads.taxRates,
    })
    .from(catalogHeads)
    .where(whereScope(catalogHeads, scope))
    .limit(1);
  const rows = yield* query(options.lock === true ? base.for('update') : base, 'Merchandise head could not be read');
  const [row] = rows;
  if (row === undefined) {
    return yield* Effect.succeed(Option.getOrUndefined(Option.none<CatalogHead>()));
  }
  if (
    row.bootstrapCheckpoint !== null &&
    !Schema.is(Schema.Struct({ status: Schema.Literal('VERIFIED') }))(row.bootstrapCheckpoint)
  ) {
    return yield* new MerchandiseStoreFailure({ reason: 'Catalog initialization has not been verified' });
  }
  const [aiChanges, homepageFeaturedProductIds, taxRates] = yield* Effect.all(
    [
      query(decodeAiSlice(row.aiChanges), 'AI changes do not decode'),
      query(
        Schema.decodeUnknownEffect(Schema.Array(ProductIdReferenceSchema))(row.homepageFeaturedProductIds),
        'AI changes do not decode',
      ),
      decodeTaxRates(row.taxRates),
    ],
    { concurrency: 1 },
  );
  return { aiChanges, homepageFeaturedProductIds, revision: row.revision, taxRates } satisfies CatalogHead;
});

/**
 * The head a write runs on, locked until commit. A company without a head row gets one at revision 0 inside the
 * caller's scoped transaction: under READ COMMITTED a concurrent first write blocks on the primary key, its insert
 * does nothing once the winner commits, and the re-read then locks the winner's committed row. So both writers
 * serialize on one row and the later one compares its expected revision against the winner's, never against 0.
 */
export const lockHeadForWrite = Effect.fn('MerchandiseStore.lockHeadForWrite')(function* lockHeadForWrite(
  db: MerchandiseDb,
  scope: StoreScope,
  options: { readonly aiChanges?: boolean } = {},
): Effect.fn.Return<CatalogHead, MerchandiseStoreFailure> {
  const locked = { ...options, lock: true };
  const existing = yield* loadHead(db, scope, locked);
  if (existing !== undefined) {
    return existing;
  }
  yield* query(
    db
      .insert(catalogHeads)
      .values({ ...scope, revision: EMPTY_CATALOG_HEAD.revision })
      .onConflictDoNothing({ target: [catalogHeads.tenantId, catalogHeads.legalEntityId] }),
    'Merchandise head could not be created',
  );
  const created = yield* loadHead(db, scope, locked);
  return created ?? (yield* new MerchandiseStoreFailure({ reason: 'Merchandise head could not be created' }));
});

/** What one command needs to see; everything else stays in the database. */
export interface WorkingSetRequest {
  readonly aiChanges?: boolean;
  /** Category rows by id, each with its ancestor chain (category path of a product move). */
  readonly categoryIds?: readonly string[];
  readonly lastOrderNumber?: boolean;
  /** Load every movement of the loaded products (stock checks and order ledgers). */
  readonly movements?: boolean;
  readonly orderClientRequestId?: string;
  readonly orderIds?: readonly string[];
  /** Category edits also need the loaded product's current primary/additional ids under this locked head. */
  readonly productCategoryMemberships?: boolean;
  readonly productIds?: readonly string[];
  /** Products that could collide with a new SKU or storefront slug (case-insensitive). */
  readonly productKeys?: { readonly sku?: string; readonly slug?: string; readonly slugPrefix?: string };
  readonly sourceCatalog?: boolean;
}

export interface WorkingSet {
  readonly revision: number;
  readonly state: MerchandiseState;
  /** Stock levels of the loaded products as stored. */
  readonly stock: ReadonlyMap<string, StockLevels>;
}

const likeEscape = (value: string) => value.replaceAll(/[\\%_]/gu, (match) => `\\${match}`);

const orderLineProductIds = (order: Order) => order.lines.map((line) => line.productId);

interface AncestorState {
  readonly depth: number;
  readonly loaded: readonly CatalogCategory[];
  readonly pending: readonly string[];
  readonly seen: ReadonlySet<string>;
}
const nextAncestorState = (state: AncestorState, decoded: readonly CatalogCategory[]): AncestorState => {
  const seen = new Set([...state.seen, ...decoded.map((category) => category.id)]);
  const pending = [
    ...new Set(
      decoded.flatMap((category) =>
        Option.match(category.parentId, {
          onNone: () => [],
          onSome: (id) => (seen.has(id) ? [] : [id]),
        }),
      ),
    ),
  ];
  return { depth: state.depth + 1, loaded: [...state.loaded, ...decoded], pending, seen };
};
const loadCategoryLevel = Effect.fn('MerchandiseStore.loadCategoryLevel')(function* loadAncestorsAtDepth(
  db: MerchandiseDb,
  scope: StoreScope,
  state: AncestorState,
) {
  if (state.pending.length === 0) {
    return state;
  }
  const rows = yield* query(
    db
      .select()
      .from(categories)
      .where(and(whereScope(categories, scope), inArray(categories.id, state.pending))),
    'Categories could not be read',
  );
  const decoded = yield* query(
    Effect.forEach(rows, decodeCategoryRow, { concurrency: 1 }),
    'Stored category does not decode',
  );
  return nextAncestorState(state, decoded);
});
const loadAncestorCategories = Effect.fn('MerchandiseStore.loadAncestorCategories')(function* loadAncestors(
  db: MerchandiseDb,
  scope: StoreScope,
  ids: WorkingSetRequest['categoryIds'],
) {
  const initial: AncestorState = { depth: 0, loaded: [], pending: [...new Set(ids)], seen: new Set() };
  const result = yield* Effect.reduce(
    Array.from({ length: 32 }),
    () => initial,
    (state) => loadCategoryLevel(db, scope, state),
  );
  return result.loaded;
});

const productKeyFilters = (keys: WorkingSetRequest['productKeys']): SQL[] => {
  const filters: SQL[] = [];
  if (keys?.sku !== undefined) {
    filters.push(eq(products.skuKey, skuKeyOf(keys.sku)));
  }
  if (keys?.slug !== undefined) {
    filters.push(sql`lower(${products.slug}) = ${keys.slug.trim().toLowerCase()}`);
  }
  if (keys?.slugPrefix !== undefined) {
    filters.push(like(sql`lower(${products.slug})`, `${likeEscape(keys.slugPrefix.toLowerCase())}%`));
  }
  return filters;
};

const categoryIdsForWorkingSet = (request: WorkingSetRequest, loadedProducts: readonly Product[]) => {
  if (request.productCategoryMemberships !== true) {
    return request.categoryIds;
  }
  return [
    ...(request.categoryIds ?? []),
    ...loadedProducts.flatMap((product) => [
      ...(product.categoryId === undefined ? [] : [product.categoryId]),
      ...(product.additionalCategoryIds ?? []),
    ]),
  ];
};

/** Loads the rows `request` names under the locked head row. */
/** The lines of one order as stored; none when the company has no such order. */
export const loadOrderLines = Effect.fn('MerchandiseStore.loadOrderLines')(function* loadOrderLines(
  db: MerchandiseDb,
  scope: StoreScope,
  orderId: string,
) {
  const rows = yield* query(
    db
      .select({ document: orders.document })
      .from(orders)
      .where(and(whereScope(orders, scope), eq(orders.id, orderId)))
      .limit(1),
    'Order could not be read',
  );
  const loaded = yield* query(
    Effect.forEach(rows, (row) => decodeOrder(row.document), { concurrency: 1 }),
    'Stored order does not decode',
  );
  return loaded.flatMap((order) => order.lines);
});

export const loadWorkingSet = Effect.fn('MerchandiseStore.loadWorkingSet')(function* loadWorkingSet(
  db: MerchandiseDb,
  scope: StoreScope,
  head: CatalogHead,
  request: WorkingSetRequest,
) {
  const orderFilters = [
    ...(request.orderIds !== undefined && request.orderIds.length > 0
      ? [inArray(orders.id, [...request.orderIds])]
      : []),
    ...(request.orderClientRequestId === undefined ? [] : [eq(orders.clientRequestId, request.orderClientRequestId)]),
  ];
  const orderRows =
    orderFilters.length === 0
      ? []
      : yield* query(
          db
            .select({ document: orders.document })
            .from(orders)
            .where(and(whereScope(orders, scope), or(...orderFilters)))
            .orderBy(asc(orders.ordinal)),
          'Orders could not be read',
        );
  const loadedOrders = yield* query(
    Effect.forEach(orderRows, (row) => decodeOrder(row.document), { concurrency: 1 }),
    'Stored order does not decode',
  );
  // Movements an order wrote may name products its current lines no longer list.
  const referencedProductIds =
    request.movements === true && loadedOrders.length > 0
      ? (yield* query(
          db
            .select({ productId: stockMovements.productId })
            .from(stockMovements)
            .where(
              and(
                whereScope(stockMovements, scope),
                inArray(
                  stockMovements.reference,
                  loadedOrders.map((order) => order.number),
                ),
              ),
            )
            .groupBy(stockMovements.productId),
        )).map((row) => row.productId)
      : [];
  const productIds = [
    ...new Set([...(request.productIds ?? []), ...loadedOrders.flatMap(orderLineProductIds), ...referencedProductIds]),
  ];
  const keyFilters = productKeyFilters(request.productKeys);
  const productFilters = [...(productIds.length === 0 ? [] : [inArray(products.id, productIds)]), ...keyFilters];
  const loaded = productFilters.length === 0 ? [] : yield* loadProducts(db, scope, or(...productFilters));
  const movementRows =
    request.movements === true && loaded.length > 0
      ? yield* query(
          db
            .select()
            .from(stockMovements)
            .where(
              and(
                whereScope(stockMovements, scope),
                inArray(
                  stockMovements.productId,
                  loaded.map((entry) => entry.product.id),
                ),
              ),
            )
            .orderBy(asc(stockMovements.ordinal)),
          'Stock movements could not be read',
        )
      : [];
  const categoryIds = categoryIdsForWorkingSet(
    request,
    loaded.map(({ product }) => product),
  );
  const [movements, loadedCategories] = yield* Effect.all(
    [
      query(Effect.forEach(movementRows, decodeMovementRow, { concurrency: 1 }), 'Stored movement does not decode'),
      loadAncestorCategories(db, scope, categoryIds),
    ],
    { concurrency: 1 },
  );
  const orderNumberPattern = `^${ORDER_NUMBER_PREFIX}[0-9]+$`;
  const lastOrderNumber =
    request.lastOrderNumber === true
      ? (yield* query(
          db
            .select({ number: orders.number })
            .from(orders)
            .where(and(whereScope(orders, scope), sql`${orders.number} ~ ${orderNumberPattern}`))
            .orderBy(desc(sql`substring(${orders.number} from ${ORDER_NUMBER_PREFIX.length + 1})::numeric`))
            .limit(1),
        ))[0]?.number
      : undefined;
  const sourceCatalog =
    request.sourceCatalog === true
      ? (yield* query(
          db
            .select({ id: products.id })
            .from(products)
            .where(and(whereScope(products, scope), sql`${products.sourceGroupId} is not null`))
            .limit(1),
        )).length > 0
      : undefined;
  let state: MerchandiseState = { movements, orders: loadedOrders, products: loaded.map((entry) => entry.product) };
  if (categoryIds !== undefined) {
    state = { ...state, categories: loadedCategories };
  }
  if (request.aiChanges === true && head.aiChanges !== undefined) {
    state = { ...state, aiChanges: head.aiChanges };
  }
  if (lastOrderNumber !== undefined) {
    state = { ...state, lastOrderNumber };
  }
  if (sourceCatalog !== undefined) {
    state = { ...state, sourceCatalog };
  }
  return {
    revision: head.revision,
    state,
    stock: new Map(loaded.map((entry) => [entry.product.id, entry.stock] as const)),
  } satisfies WorkingSet;
});

// ------------------------------------------------------------------------------------------------ persisting

const changedEntities = <T extends { readonly id: string }>(before: readonly T[], after: readonly T[]) => {
  const previous = new Map(before.map((entity) => [entity.id, entity] as const));
  return after.filter((entity) => previous.get(entity.id) !== entity);
};

const upsertSet = <Row extends ProductRow | OrderRow | CategoryRow>(row: Row) => {
  const { id: _id, legalEntityId: _entity, ordinal: _ordinal, tenantId: _tenant, ...set } = row;
  void _tenant;
  void _entity;
  void _id;
  void _ordinal;
  return set;
};

const stockChangesOf = (working: WorkingSet, after: MerchandiseState) => {
  const before = working.state;
  const knownMovements = new Set(before.movements.map((movement) => movement.id));
  const newMovements = after.movements.filter((movement) => !knownMovements.has(movement.id));
  const deltas = new Map<string, { total: number; variants: Map<string, number> }>();
  for (const movement of newMovements) {
    const entry = deltas.get(movement.productId) ?? { total: 0, variants: new Map<string, number>() };
    entry.total += movement.delta;
    if (movement.variantId !== undefined) {
      entry.variants.set(movement.variantId, (entry.variants.get(movement.variantId) ?? 0) + movement.delta);
    }
    deltas.set(movement.productId, entry);
  }
  const stockAfter = (productId: string): StockLevels => {
    const stored = working.stock.get(productId) ?? { total: 0, variants: new Map<string, number>() };
    const delta = deltas.get(productId);
    if (delta === undefined) {
      return stored;
    }
    const variants = new Map(stored.variants);
    for (const [variantId, change] of delta.variants) {
      variants.set(variantId, (variants.get(variantId) ?? 0) + change);
    }
    return { total: stored.total + delta.total, variants };
  };
  const changedProducts = changedEntities(before.products, after.products);
  const changedIds = new Set(changedProducts.map((product) => product.id));
  const stockOnly = after.products.filter((product) => !changedIds.has(product.id) && deltas.has(product.id));
  const unknownStock = [...deltas.keys()].filter(
    (productId) => !after.products.some((product) => product.id === productId),
  );
  return { changedProducts, deltas, newMovements, stockAfter, stockOnly, unknownStock };
};
type StockChanges = ReturnType<typeof stockChangesOf>;

const persistRewrittenProducts = Effect.fn('MerchandiseStore.persistRewrittenProducts')(
  function* persistProductDocuments(db: MerchandiseDb, scope: StoreScope, rewritten: readonly ProductRows[]) {
    if (rewritten.length === 0) {
      return yield* Effect.void;
    }
    const ids = rewritten.map((entry) => entry.row.id);
    yield* query(db.delete(priceTiers).where(and(whereScope(priceTiers, scope), inArray(priceTiers.productId, ids))));
    yield* query(
      db
        .delete(productVariants)
        .where(and(whereScope(productVariants, scope), inArray(productVariants.productId, ids))),
    );
    yield* Effect.forEach(
      rewritten,
      (entry) =>
        query(
          db
            .insert(products)
            .values(entry.row)
            .onConflictDoUpdate({
              set: upsertSet(entry.row),
              target: [products.tenantId, products.legalEntityId, products.id],
            }),
          'Product could not be written',
        ),
      { concurrency: 1, discard: true },
    );
    yield* writeBatches(
      rewritten.flatMap((entry) => entry.variants),
      1500,
      (batch) => query(db.insert(productVariants).values([...batch]), 'Variants could not be written'),
    );
    return yield* writeBatches(
      rewritten.flatMap((entry) => entry.tiers),
      2500,
      (batch) => query(db.insert(priceTiers).values([...batch]), 'Price tiers could not be written'),
    );
  },
);

const persistStockUpdates = Effect.fn('MerchandiseStore.persistStockUpdates')(function* persistStockColumns(
  db: MerchandiseDb,
  scope: StoreScope,
  { deltas, stockAfter, stockOnly }: StockChanges,
  rates: SellableVatRates,
  held: HeldRates,
) {
  yield* Effect.forEach(
    stockOnly,
    Effect.fn('MerchandiseStore.persistProductStock')(function* persistProductStock(product: Product) {
      const stock = stockAfter(product.id);
      const derived = yield* attempt('Stock projection failed', () => derivedColumns(product, stock, rates, held));
      yield* query(
        db
          .update(products)
          .set(derived)
          .where(and(whereScope(products, scope), eq(products.id, product.id))),
        'Product stock could not be written',
      );
      yield* Effect.forEach(
        deltas.get(product.id)?.variants.keys() ?? [],
        (variantId) =>
          query(
            db
              .update(productVariants)
              .set({ stockOnHand: stock.variants.get(variantId) ?? 0 })
              .where(
                and(
                  whereScope(productVariants, scope),
                  eq(productVariants.productId, product.id),
                  eq(productVariants.variantId, variantId),
                ),
              ),
            'Variant stock could not be written',
          ),
        { concurrency: 1, discard: true },
      );
    }),
    { concurrency: 1, discard: true },
  );
});

const persistCategories = Effect.fn('MerchandiseStore.persistCategories')(function* persistCategoryDocuments(
  db: MerchandiseDb,
  scope: StoreScope,
  before: MerchandiseState,
  after: MerchandiseState,
  now: DateTime.Utc,
) {
  const previousCategories = new Map((before.categories ?? []).map((category) => [category.id, category] as const));
  yield* Effect.forEach(
    changedEntities(before.categories ?? [], after.categories ?? []),
    Effect.fn('MerchandiseStore.persistCategory')(function* persistCategory(category: CatalogCategory) {
      const row = yield* query(categoryRowOf(scope, category), 'Category does not encode');
      const previous = previousCategories.get(category.id);
      if (previous === undefined) {
        // A category the company just added (CreateCategory): the tree may grow after it has products.
        yield* query(db.insert(categories).values(row), 'Category could not be written');
        return;
      }
      yield* query(
        db
          .update(categories)
          .set(upsertSet(row))
          .where(and(whereScope(categories, scope), eq(categories.id, category.id))),
        'Category could not be written',
      );
      const renamed = previous.name !== category.name;
      if (renamed) {
        // Products of the category carry its name; one statement renames all of them, loaded or not.
        const name = category.name.slice(0, 120);
        const at = DateTime.formatIso(now);
        yield* query(
          db
            .update(products)
            .set({
              category: name,
              document: sql`jsonb_set(jsonb_set(${products.document}, '{category}', to_jsonb(${name}::text)), '{updatedAt}', to_jsonb(${at}::text))`,
              updatedAt: date(now),
            })
            .where(and(whereScope(products, scope), eq(products.categoryId, category.id))),
          'Category products could not be renamed',
        );
      }
    }),
    { concurrency: 1, discard: true },
  );
});

// True once this process saw the marker name its own release (a process serves one release).
const taxClassificationLiveSeen = Ref.makeUnsafe(false);

/**
 * Records that this release serves (`tax_classification_live`): its composition revision, on its first catalogue write.
 * Every write reaches here only inside a transaction the composition fence admitted, so the active composition the
 * database function reads is this release's own. The contract step of the VAT classification refuses to run unless the
 * recorded revision is the one serving then: the release being replaced must be one that no longer reads `vatRate`.
 */
const recordTaxClassificationLive = Effect.fn('MerchandiseStore.recordTaxClassificationLive')(
  function* recordTaxClassificationLive(db: MerchandiseDb, scope: StoreScope) {
    if (yield* Ref.get(taxClassificationLiveSeen)) {
      return;
    }
    // Once, on the company's head the write holds locked (the scoped executor runs no free-standing statement).
    const [recorded] = yield* query(
      db
        .select({ outcome: sql<string>`demo_merchandise.record_tax_classification_live()` })
        .from(catalogHeads)
        .where(whereScope(catalogHeads, scope))
        .limit(1),
      'The serving release could not be recorded',
    );
    if (recorded?.outcome === 'current') {
      yield* Ref.set(taxClassificationLiveSeen, true);
    } else if (recorded?.outcome === 'unrecorded') {
      yield* Effect.logWarning('The serving release could not be recorded; the next catalogue write tries again');
    }
  },
);

/**
 * A held product this write reclassified away from reduced loses its hold in the same write: holds apply only to
 * reduced products, and this release owns its company's holds (the expand step's triggers pass its writes through).
 */
const dropReclassifiedHolds = Effect.fn('MerchandiseStore.dropReclassifiedHolds')(function* dropReclassifiedHolds(
  db: MerchandiseDb,
  scope: StoreScope,
  changedProducts: readonly Product[],
  held: HeldRates,
) {
  const dropped = changedProducts.flatMap((product) =>
    held[product.id] !== undefined && product.taxClassificationCode !== CZ_VAT_REDUCED ? [product.id] : [],
  );
  if (dropped.length === 0) {
    return;
  }
  yield* query(
    db
      .update(catalogHeads)
      .set({
        taxRates: sql`jsonb_set(${catalogHeads.taxRates}, '{heldProductRates}',
          (${catalogHeads.taxRates} -> 'heldProductRates') - array[${sql.join(
            dropped.map((id) => sql`${id}`),
            sql`, `,
          )}]::text[])`,
      })
      .where(and(whereScope(catalogHeads, scope), sql`${catalogHeads.taxRates} ? 'heldProductRates'`)),
    'The dropped holds could not be written',
  );
});

/**
 * Writes exactly what changed between the working set and the command's result: new movements, rewritten
 * products (row + variants + tiers) or only their stock columns, changed orders and categories, the AI slice, and
 * the head revision. Reducers keep unchanged entities by reference, so reference inequality marks a change.
 */
export const persistChange = Effect.fn('MerchandiseStore.persistChange')(function* persistChange(
  db: MerchandiseDb,
  scope: StoreScope,
  working: WorkingSet,
  after: MerchandiseState,
  now: DateTime.Utc,
  rates: SellableVatRates,
  held: HeldRates,
) {
  const before = working.state;
  const changes = stockChangesOf(working, after);
  const { changedProducts, newMovements, stockAfter, unknownStock } = changes;
  if (unknownStock.length > 0) {
    return yield* new MerchandiseStoreFailure({ reason: `Stock movement for an unloaded product ${unknownStock[0]}` });
  }
  const rewritten = yield* query(
    Effect.forEach(changedProducts, (product) => productRowsOf(scope, product, stockAfter(product.id), rates, held), {
      concurrency: 1,
    }),
    'Changed products do not encode',
  );
  yield* writeBatches(
    newMovements.map((movement) => movementRowOf(scope, movement)),
    2500,
    (batch) => query(db.insert(stockMovements).values([...batch]), 'Stock movements could not be written'),
  );
  yield* persistRewrittenProducts(db, scope, rewritten);
  yield* persistStockUpdates(db, scope, changes, rates, held);
  const changedOrders = yield* query(
    Effect.forEach(changedEntities(before.orders, after.orders), (order) => orderRowOf(scope, order), {
      concurrency: 1,
    }),
    'Changed orders do not encode',
  );
  yield* Effect.forEach(
    changedOrders,
    (row) =>
      query(
        db
          .insert(orders)
          .values(row)
          .onConflictDoUpdate({ set: upsertSet(row), target: [orders.tenantId, orders.legalEntityId, orders.id] }),
        'Order could not be written',
      ),
    { concurrency: 1, discard: true },
  );
  yield* persistCategories(db, scope, before, after, now);
  const sliceChanged = after.aiChanges !== before.aiChanges;
  const slice =
    sliceChanged && after.aiChanges !== undefined
      ? yield* query(encodeSlice(after.aiChanges), 'AI changes do not encode')
      : undefined;
  yield* dropReclassifiedHolds(db, scope, changedProducts, held);
  yield* recordTaxClassificationLive(db, scope);
  const update = { revision: working.revision + 1, updatedAt: date(now) };
  const heads = yield* query(
    db
      .update(catalogHeads)
      .set(sliceChanged ? { ...update, aiChanges: slice ?? null } : update)
      .where(and(whereScope(catalogHeads, scope), eq(catalogHeads.revision, working.revision)))
      .returning({ revision: catalogHeads.revision }),
    'Merchandise head could not be written',
  );
  return heads.length === 1 ? working.revision + 1 : undefined;
});

/** Full company snapshot for admin scripts only (seed merge, presentation repair). Never used by requests. */
export const readSnapshot = Effect.fn('MerchandiseStore.readSnapshot')(function* readSnapshot(
  db: MerchandiseDb,
  scope: StoreScope,
): Effect.fn.Return<
  { readonly revision: number; readonly state: MerchandiseState } | undefined,
  MerchandiseStoreFailure
> {
  const head = yield* loadHead(db, scope, { aiChanges: true });
  if (head === undefined) {
    return Option.getOrUndefined(Option.none<Pick<WorkingSet, 'revision' | 'state'>>());
  }
  const [loaded, movementRows, orderRows, categoryRows] = yield* Effect.all(
    [
      loadProducts(db, scope),
      query(
        db.select().from(stockMovements).where(whereScope(stockMovements, scope)).orderBy(asc(stockMovements.ordinal)),
      ),
      query(
        db
          .select({ document: orders.document })
          .from(orders)
          .where(whereScope(orders, scope))
          .orderBy(asc(orders.ordinal)),
      ),
      query(db.select().from(categories).where(whereScope(categories, scope)).orderBy(asc(categories.ordinal))),
    ],
    { concurrency: 1 },
  );
  return yield* query(
    Effect.gen(function* decodeSnapshot() {
      const movements = yield* Effect.forEach(movementRows, decodeMovementRow, { concurrency: 1 });
      const decodedOrders = yield* Effect.forEach(orderRows, (row) => decodeOrder(row.document), { concurrency: 1 });
      let state: MerchandiseState = {
        movements,
        orders: decodedOrders,
        products: loaded.map((entry) => entry.product),
      };
      if (categoryRows.length > 0) {
        state = { ...state, categories: yield* Effect.forEach(categoryRows, decodeCategoryRow, { concurrency: 1 }) };
      }
      if (head.homepageFeaturedProductIds.length > 0) {
        state = { ...state, homepageFeaturedProductIds: [...head.homepageFeaturedProductIds] };
      }
      if (head.aiChanges !== undefined) {
        state = { ...state, aiChanges: head.aiChanges };
      }
      return { revision: head.revision, state };
    }),
    'Stored snapshot does not decode',
  );
});
