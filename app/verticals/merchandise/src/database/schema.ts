// Merchandise storage: one row per product, variant, price tier, category, stock movement and order, each keyed by
// tenant + legal entity and guarded by row-level security. `catalog_heads` holds the per-company revision every
// write bumps (optimistic concurrency + write serialization), the homepage selection and the AI approval slice.
// Products and variants keep their full encoded document in `document`; the columns beside it are the queryable
// projection (filters, sort, paging, indicators) written from the same value in the same statement.
import { tenantLegalEntityRlsPolicies } from '@app/core-runtime';
import { defineRelations, sql } from 'drizzle-orm';
import {
  bigint,
  boolean,
  check,
  doublePrecision,
  index,
  integer,
  jsonb,
  pgSchema,
  primaryKey,
  smallint,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';

export const merchandiseSchema = pgSchema('demo_merchandise');

const scopeColumns = {
  legalEntityId: uuid('legal_entity_id').notNull(),
  tenantId: uuid('tenant_id').notNull(),
};
const minor = (name: string) => bigint(name, { mode: 'number' });
const ordinal = () => bigint('ordinal', { mode: 'number' }).generatedByDefaultAsIdentity();

export const catalogHeads = merchandiseSchema.table.withRLS(
  'catalog_heads',
  {
    ...scopeColumns,
    aiChanges: jsonb('ai_changes'),
    homepageFeaturedProductIds: text('homepage_featured_product_ids')
      .array()
      .default(sql`'{}'::text[]`)
      .notNull(),
    revision: integer('revision').default(0).notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.tenantId, table.legalEntityId] }),
    check('demo_merchandise_head_revision_nonnegative', sql`${table.revision} >= 0`),
    ...tenantLegalEntityRlsPolicies('demo_merchandise_head_scope', table.tenantId, table.legalEntityId),
  ],
);

export const products = merchandiseSchema.table.withRLS(
  'products',
  {
    ...scopeColumns,
    active: boolean('active').notNull(),
    archived: boolean('archived').notNull(),
    availability: text('availability').notNull(),
    category: text('category').notNull(),
    categoryId: text('category_id'),
    categoryPathIds: text('category_path_ids')
      .array()
      .default(sql`'{}'::text[]`)
      .notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull(),
    currentPriceMinor: minor('current_price_minor').notNull(),
    document: jsonb('document').notNull(),
    featuredPosition: doublePrecision('featured_position'),
    grossPriceMinor: minor('gross_price_minor'),
    hasPhoto: boolean('has_photo').notNull(),
    id: text('id').notNull(),
    isAction: boolean('is_action').notNull(),
    isNew: boolean('is_new').notNull(),
    isRecommended: boolean('is_recommended').notNull(),
    isSale: boolean('is_sale').notNull(),
    lowStock: boolean('low_stock').notNull(),
    name: text('name').notNull(),
    /** Name folded like storefront search (no diacritics, lower case) for relevance ranking. */
    nameKey: text('name_key').notNull(),
    ordinal: ordinal(),
    published: boolean('published').notNull(),
    /** Folded name, SKU, short description, parameters and variant texts; every search word must occur. */
    searchText: text('search_text').notNull(),
    sku: text('sku').notNull(),
    skuKey: text('sku_key').notNull(),
    slug: text('slug'),
    sourceGroupId: text('source_group_id'),
    stockOnHand: doublePrecision('stock_on_hand').notNull(),
    stockValueMinor: minor('stock_value_minor').notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.tenantId, table.legalEntityId, table.id] }),
    uniqueIndex('demo_merchandise_products_sku').on(table.tenantId, table.legalEntityId, table.skuKey),
    index('demo_merchandise_products_ordinal').on(table.tenantId, table.legalEntityId, table.ordinal),
    index('demo_merchandise_products_slug').on(table.tenantId, table.legalEntityId, table.slug),
    index('demo_merchandise_products_category').on(table.tenantId, table.legalEntityId, table.categoryId),
    index('demo_merchandise_products_category_path').using('gin', table.categoryPathIds),
    index('demo_merchandise_products_price').on(table.tenantId, table.legalEntityId, table.grossPriceMinor),
    check('demo_merchandise_product_document_object', sql`jsonb_typeof(${table.document}) = 'object'`),
    ...tenantLegalEntityRlsPolicies('demo_merchandise_product_scope', table.tenantId, table.legalEntityId),
  ],
);

export const productVariants = merchandiseSchema.table.withRLS(
  'product_variants',
  {
    ...scopeColumns,
    active: boolean('active').notNull(),
    document: jsonb('document').notNull(),
    /** Gross unit price the storefront shows (first tier, else net + VAT); null for informational variants. */
    grossPriceMinor: minor('gross_price_minor'),
    name: text('name').notNull(),
    position: integer('position').notNull(),
    priceMinor: minor('price_minor'),
    productId: text('product_id').notNull(),
    sku: text('sku'),
    stockOnHand: doublePrecision('stock_on_hand').notNull(),
    /** Sales unit (variant unit, source unit, else the product unit). */
    unit: text('unit').notNull(),
    /** Null for informational variants (name/attributes only, not sellable). */
    variantId: text('variant_id'),
  },
  (table) => [
    primaryKey({ columns: [table.tenantId, table.legalEntityId, table.productId, table.position] }),
    index('demo_merchandise_variants_id').on(table.tenantId, table.legalEntityId, table.productId, table.variantId),
    check('demo_merchandise_variant_document_object', sql`jsonb_typeof(${table.document}) = 'object'`),
    ...tenantLegalEntityRlsPolicies('demo_merchandise_variant_scope', table.tenantId, table.legalEntityId),
  ],
);

/** Quantity price breaks; `variant_position` -1 = the product's own tiers. Ordered by `position`. */
export const priceTiers = merchandiseSchema.table.withRLS(
  'price_tiers',
  {
    ...scopeColumns,
    minimumQuantity: doublePrecision('minimum_quantity').notNull(),
    position: smallint('position').notNull(),
    priceExcludingVatMinor: minor('price_excluding_vat_minor').notNull(),
    priceMinor: minor('price_minor').notNull(),
    productId: text('product_id').notNull(),
    variantPosition: integer('variant_position').notNull(),
  },
  (table) => [
    primaryKey({
      columns: [table.tenantId, table.legalEntityId, table.productId, table.variantPosition, table.position],
    }),
    ...tenantLegalEntityRlsPolicies('demo_merchandise_tier_scope', table.tenantId, table.legalEntityId),
  ],
);

export const categories = merchandiseSchema.table.withRLS(
  'categories',
  {
    ...scopeColumns,
    description: text('description').notNull(),
    hasChildren: boolean('has_children').notNull(),
    heading: text('heading').notNull(),
    history: jsonb('history'),
    id: text('id').notNull(),
    imageAlt: text('image_alt').notNull(),
    imageSrc: text('image_src').notNull(),
    longDescription: text('long_description').notNull(),
    name: text('name').notNull(),
    ordinal: ordinal(),
    parentId: text('parent_id'),
    position: doublePrecision('position').notNull(),
    published: boolean('published'),
    slug: text('slug').notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.tenantId, table.legalEntityId, table.id] }),
    index('demo_merchandise_categories_slug').on(table.tenantId, table.legalEntityId, table.slug),
    ...tenantLegalEntityRlsPolicies('demo_merchandise_category_scope', table.tenantId, table.legalEntityId),
  ],
);

/** Append-only stock ledger; `products.stock_on_hand` / `product_variants.stock_on_hand` are its sums. */
export const stockMovements = merchandiseSchema.table.withRLS(
  'stock_movements',
  {
    ...scopeColumns,
    at: timestamp('at', { withTimezone: true }).notNull(),
    delta: doublePrecision('delta').notNull(),
    id: text('id').notNull(),
    note: text('note'),
    ordinal: ordinal(),
    productId: text('product_id').notNull(),
    reason: text('reason').notNull(),
    reference: text('reference'),
    variantId: text('variant_id'),
  },
  (table) => [
    primaryKey({ columns: [table.tenantId, table.legalEntityId, table.id] }),
    index('demo_merchandise_movements_product').on(table.tenantId, table.legalEntityId, table.productId, table.ordinal),
    index('demo_merchandise_movements_reference').on(table.tenantId, table.legalEntityId, table.reference),
    ...tenantLegalEntityRlsPolicies('demo_merchandise_movement_scope', table.tenantId, table.legalEntityId),
  ],
);

/** One order; `document` is the full encoded order (lines are immutable snapshots, history is bounded). */
export const orders = merchandiseSchema.table.withRLS(
  'orders',
  {
    ...scopeColumns,
    channel: text('channel'),
    clientRequestId: text('client_request_id'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull(),
    document: jsonb('document').notNull(),
    id: text('id').notNull(),
    number: text('number').notNull(),
    opportunityId: text('opportunity_id'),
    ordinal: ordinal(),
    partyId: text('party_id').notNull(),
    /** DEMO cleanup: hidden from staff lists, kept for audit and replay. */
    removed: boolean('removed').notNull(),
    searchText: text('search_text').notNull(),
    status: text('status').notNull(),
    totalMinor: minor('total_minor').notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.tenantId, table.legalEntityId, table.id] }),
    uniqueIndex('demo_merchandise_orders_number').on(table.tenantId, table.legalEntityId, table.number),
    index('demo_merchandise_orders_client_request').on(table.tenantId, table.legalEntityId, table.clientRequestId),
    index('demo_merchandise_orders_created').on(table.tenantId, table.legalEntityId, table.createdAt),
    index('demo_merchandise_orders_opportunity').on(table.tenantId, table.legalEntityId, table.opportunityId),
    check('demo_merchandise_order_document_object', sql`jsonb_typeof(${table.document}) = 'object'`),
    ...tenantLegalEntityRlsPolicies('demo_merchandise_order_scope', table.tenantId, table.legalEntityId),
  ],
);

export const gatewayAssertionRedemptions = merchandiseSchema.table(
  'gateway_assertion_redemptions',
  {
    audience: text('audience').notNull(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    issuer: text('issuer').notNull(),
    jti: text('jti').notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.issuer, table.audience, table.jti] }),
    index('demo_merchandise_redemption_expiry').on(table.expiresAt),
  ],
);

export const merchandiseRelations = defineRelations({
  catalogHeads,
  categories,
  gatewayAssertionRedemptions,
  orders,
  priceTiers,
  products,
  productVariants,
  stockMovements,
});
