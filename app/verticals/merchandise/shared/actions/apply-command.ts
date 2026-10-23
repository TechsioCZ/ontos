import { Schema } from 'effect';
import { MerchandiseScopeMismatch } from '../errors/merchandise-scope-mismatch.ts';
import { MerchandiseNotFound } from '../errors/merchandise-not-found.ts';
import { MerchandiseLifecycleConflict } from '../errors/merchandise-lifecycle-conflict.ts';
import { MerchandiseRevisionConflict } from '../errors/merchandise-revision-conflict.ts';
import { MerchandisePersistenceUnavailable } from '../errors/merchandise-persistence-unavailable.ts';
import { MerchandiseReferenceUnavailable } from '../errors/merchandise-reference-unavailable.ts';
import { MerchandiseReferenceIneligible } from '../errors/merchandise-reference-ineligible.ts';
import { MerchandisePermissionDenied } from '../errors/merchandise-permission-denied.ts';
import { MerchandiseNotImplemented } from '../errors/merchandise-not-implemented.ts';
import {
  AvailabilitySchema,
  EntityIdSchema,
  MinorAmountSchema,
  OpportunityIdSchema,
  OrderAddressSchema,
  OrderContactSchema,
  OrderIdSchema,
  OrderStatusSchema,
  PartyIdSchema,
  ProductIdSchema,
  ProductMetadataSchema,
  ProductUnitSchema,
  ShippingMethodSchema,
  VariantIdSchema,
  VatRateSchema,
} from '../domain/merchandise-model.ts';

export const ProductPatchSchema = Schema.Struct({
  ...ProductMetadataSchema.fields,
  active: Schema.optionalKey(Schema.Boolean),
  category: Schema.optionalKey(Schema.Trim.check(Schema.isMinLength(1), Schema.isMaxLength(120))),
  lowStockThreshold: Schema.optionalKey(MinorAmountSchema),
  name: Schema.optionalKey(Schema.Trim.check(Schema.isMinLength(1), Schema.isMaxLength(200))),
  unit: Schema.optionalKey(ProductUnitSchema),
  vatRate: Schema.optionalKey(VatRateSchema),
});
export type ProductPatch = typeof ProductPatchSchema.Type;

export const BulkProductPatchSchema = Schema.Struct({
  active: Schema.optionalKey(Schema.Boolean),
  category: Schema.optionalKey(Schema.Trim.check(Schema.isMinLength(1), Schema.isMaxLength(120))),
  /** Whole-percent change applied to currentPriceMinor; each changed product appends a priceHistory entry. */
  priceChangePercent: Schema.optionalKey(Schema.Int.check(Schema.isBetween({ maximum: 1000, minimum: -90 }))),
});
export type BulkProductPatch = typeof BulkProductPatchSchema.Type;

/** Editable storefront category content. Slug and parent stay fixed (they are public URLs / the tree). */
export const CategoryPatchSchema = Schema.Struct({
  published: Schema.optionalKey(Schema.Boolean),
  name: Schema.optionalKey(Schema.Trim.check(Schema.isMinLength(1), Schema.isMaxLength(200))),
  heading: Schema.optionalKey(Schema.Trim.check(Schema.isMaxLength(300))),
  description: Schema.optionalKey(Schema.Trim.check(Schema.isMaxLength(5000))),
  longDescription: Schema.optionalKey(Schema.Trim.check(Schema.isMaxLength(50_000))),
  position: Schema.optionalKey(Schema.Int.check(Schema.isGreaterThanOrEqualTo(0))),
  imageSrc: Schema.optionalKey(Schema.Trim.check(Schema.isMaxLength(500))),
  imageAlt: Schema.optionalKey(Schema.Trim.check(Schema.isMaxLength(300))),
});
export type CategoryPatch = typeof CategoryPatchSchema.Type;

export const OrderLineRequestSchema = Schema.Struct({
  productId: ProductIdSchema,
  quantity: Schema.Finite.check(Schema.isGreaterThan(0)),
  variantId: Schema.optionalKey(VariantIdSchema),
});

const QuantitySchema = Schema.Finite.check(Schema.isBetween({ maximum: 1000000, minimum: 0.001 }));

/** One storefront cart line: the gross unit price the customer saw is re-validated on the server. */
export const StorefrontOrderLineRequestSchema = Schema.Struct({
  expectedUnitPriceMinor: MinorAmountSchema,
  productId: ProductIdSchema,
  quantity: QuantitySchema,
  variantId: Schema.optionalKey(VariantIdSchema),
});

/**
 * One edited order line (admin). An existing line is matched by product+variant and keeps its snapshot unless
 * `unitPriceMinor` overrides it; a new line snapshots the current product/variant. The unit price is in the
 * order's price mode (gross for storefront orders, net for staff orders).
 */
export const EditOrderLineSchema = Schema.Struct({
  productId: ProductIdSchema,
  quantity: QuantitySchema,
  unitPriceMinor: Schema.optionalKey(MinorAmountSchema),
  variantId: Schema.optionalKey(VariantIdSchema),
});

/**
 * Commands. Server-assigned identities: CreateProduct and RecordStockMovement take the invocation id.
 * CreateOrder carries a caller-supplied id so seeds and retries can reference it deterministically.
 * The server snapshots name, SKU, unit price and VAT onto each order line at creation (req. 7d).
 * ORDER stock movements are written only by CreateOrder, so RecordStockMovement accepts manual reasons only.
 */
/** AI level C: the only order operations an agent may PROPOSE. A person approves each one in the app. */
export const MerchandiseAiOperationSchema = Schema.Union([
  Schema.TaggedStruct('ChangeOrderStatus', {
    id: OrderIdSchema,
    reason: Schema.optionalKey(Schema.Trim.check(Schema.isMaxLength(500))),
    status: OrderStatusSchema,
  }),
  Schema.TaggedStruct('EditOrder', {
    contact: Schema.optionalKey(OrderContactSchema),
    deliveryAddress: Schema.optionalKey(OrderAddressSchema),
    id: OrderIdSchema,
    lines: Schema.optionalKey(Schema.Array(EditOrderLineSchema).check(Schema.isMinLength(1), Schema.isMaxLength(200))),
    note: Schema.optionalKey(Schema.Trim.check(Schema.isMaxLength(1000))),
    reason: Schema.optionalKey(Schema.Trim.check(Schema.isMaxLength(500))),
    shipping: Schema.optionalKey(Schema.Struct({ method: ShippingMethodSchema, priceMinor: MinorAmountSchema })),
  }),
]);
export type MerchandiseAiOperation = typeof MerchandiseAiOperationSchema.Type;

const AiReasonSchema = Schema.Trim.check(Schema.isMinLength(3), Schema.isMaxLength(2000));
const AiIdSchema = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(300));

/** AI approval commands (shared engine `@app/shared-contracts/ai-approvals`). Decide and revert are human-only. */
export const merchandiseAiCommandSchemas = [
  Schema.TaggedStruct('AiProposeChanges', {
    agentLabel: Schema.optionalKey(Schema.Trim.check(Schema.isMinLength(1), Schema.isMaxLength(200))),
    changes: Schema.Array(Schema.Struct({ operation: MerchandiseAiOperationSchema, reason: AiReasonSchema })).check(
      Schema.isMinLength(1),
      Schema.isMaxLength(20),
    ),
    instruction: AiReasonSchema,
    runId: Schema.optionalKey(Schema.Trim.check(Schema.isMinLength(1), Schema.isMaxLength(200))),
  }),
  Schema.TaggedStruct('AiDecideChanges', {
    changeIds: Schema.Array(AiIdSchema).check(Schema.isMinLength(1), Schema.isMaxLength(50)),
    decision: Schema.Literals(['approve', 'reject']),
    note: Schema.optionalKey(Schema.Trim.check(Schema.isMaxLength(2000))),
  }),
  Schema.TaggedStruct('AiRevertBatch', {
    batchId: AiIdSchema,
    note: Schema.optionalKey(Schema.Trim.check(Schema.isMaxLength(2000))),
  }),
] as const;

export const MerchandiseCommandSchema = Schema.Union([
  Schema.TaggedStruct('CreateProduct', {
    ...ProductMetadataSchema.fields,
    active: Schema.Boolean,
    category: Schema.Trim.check(Schema.isMinLength(1), Schema.isMaxLength(120)),
    lowStockThreshold: MinorAmountSchema,
    name: Schema.Trim.check(Schema.isMinLength(1), Schema.isMaxLength(200)),
    priceMinor: MinorAmountSchema,
    sku: Schema.Trim.check(Schema.isMinLength(1), Schema.isMaxLength(64)),
    unit: ProductUnitSchema,
    vatRate: VatRateSchema,
  }),
  /** Edits one storefront category; appends a history entry. A renamed category also renames its products' `category`. */
  Schema.TaggedStruct('UpdateCategory', {
    id: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(300)),
    patch: CategoryPatchSchema,
  }),
  Schema.TaggedStruct('UpdateProduct', {
    id: ProductIdSchema,
    patch: ProductPatchSchema,
  }),
  Schema.TaggedStruct('ChangePrice', {
    id: ProductIdSchema,
    priceMinor: MinorAmountSchema,
    /** When set, reprices only this variant (net price) and appends to the variant price history. */
    variantId: Schema.optionalKey(VariantIdSchema),
  }),
  Schema.TaggedStruct('BulkUpdateProducts', {
    ids: Schema.Array(ProductIdSchema).check(Schema.isMinLength(1), Schema.isMaxLength(500)),
    patch: BulkProductPatchSchema,
  }),
  Schema.TaggedStruct('RecordStockMovement', {
    delta: Schema.Int,
    note: Schema.optionalKey(Schema.Trim.check(Schema.isMaxLength(2000))),
    productId: ProductIdSchema,
    reason: Schema.Literals(['RECEIPT', 'ISSUE', 'ADJUSTMENT']),
    variantId: Schema.optionalKey(VariantIdSchema),
  }),
  Schema.TaggedStruct('CreateOrder', {
    id: OrderIdSchema,
    lines: Schema.Array(OrderLineRequestSchema).check(Schema.isMinLength(1), Schema.isMaxLength(200)),
    opportunityId: Schema.optionalKey(OpportunityIdSchema),
    partyId: PartyIdSchema,
  }),
  Schema.TaggedStruct('ArchiveDemoProduct', {
    id: ProductIdSchema,
    reason: Schema.Trim.check(Schema.isMinLength(5), Schema.isMaxLength(500)),
  }),
  /**
   * AKROS administrators only: replaces this company's catalog, stock and orders with the predictable demo baseline
   * (the same state `demo:seed:akros --reset` writes). Scoped to the caller's tenant and legal entity.
   */
  Schema.TaggedStruct('ResetDemoData', {
    confirmation: Schema.Literal('OBNOVIT'),
    reason: Schema.Trim.check(Schema.isMinLength(5), Schema.isMaxLength(500)),
  }),
  Schema.TaggedStruct('RemoveDemoOrder', {
    id: OrderIdSchema,
    /** Explicit legacy repair only; ordinary cleanup replay never credits previously compensated records. */
    repairStock: Schema.optionalKey(Schema.Boolean),
    reason: Schema.Trim.check(Schema.isMinLength(5), Schema.isMaxLength(500)),
  }),
  Schema.TaggedStruct('ChangeOrderStatus', {
    id: OrderIdSchema,
    reason: Schema.optionalKey(Schema.Trim.check(Schema.isMaxLength(500))),
    status: OrderStatusSchema,
  }),
  /**
   * Order from the storefront. Idempotent by `clientRequestId`: a repeated id returns the stored order
   * (outcome REPLAYED) and saves nothing. Prices and availability are re-validated on the server; any mismatch
   * returns outcome REJECTED with readable issues and the current prices, and saves nothing. A PLACED order writes one
   * negative ORDER stock movement per line (reference = order number) in the same save; cancelling returns it.
   */
  Schema.TaggedStruct('PlaceStorefrontOrder', {
    partyId: Schema.optionalKey(PartyIdSchema),
    customerAccountId: Schema.optionalKey(Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(300))),
    clientRequestId: Schema.Trim.check(Schema.isMinLength(8), Schema.isMaxLength(120)),
    contact: Schema.optionalKey(OrderContactSchema),
    deliveryAddress: Schema.optionalKey(OrderAddressSchema),
    dryRun: Schema.optionalKey(Schema.Boolean),
    expectedShippingPriceMinor: Schema.optionalKey(MinorAmountSchema),
    lines: Schema.Array(StorefrontOrderLineRequestSchema).check(Schema.isMinLength(1), Schema.isMaxLength(50)),
    note: Schema.optionalKey(Schema.Trim.check(Schema.isMaxLength(1000))),
    shippingMethod: ShippingMethodSchema,
  }),
  /** Admin edit of an open order; each changed aspect appends a before/after history entry. */
  Schema.TaggedStruct('EditOrder', {
    contact: Schema.optionalKey(OrderContactSchema),
    deliveryAddress: Schema.optionalKey(OrderAddressSchema),
    /**
     * The order's `updatedAt` the editor saw. When present the edit conflicts only if this order changed meanwhile,
     * not when any other part of the catalog (e.g. a storefront order) bumped the aggregate revision.
     */
    expectedUpdatedAt: Schema.optionalKey(Schema.DateTimeUtcFromString),
    id: OrderIdSchema,
    lines: Schema.optionalKey(Schema.Array(EditOrderLineSchema).check(Schema.isMinLength(1), Schema.isMaxLength(200))),
    note: Schema.optionalKey(Schema.Trim.check(Schema.isMaxLength(1000))),
    reason: Schema.optionalKey(Schema.Trim.check(Schema.isMaxLength(500))),
    shipping: Schema.optionalKey(Schema.Struct({ method: ShippingMethodSchema, priceMinor: MinorAmountSchema })),
  }),
  ...merchandiseAiCommandSchemas,
]);
export type MerchandiseCommand = typeof MerchandiseCommandSchema.Type;
export const ApplyCommandPayloadSchema = Schema.Struct({
  command: MerchandiseCommandSchema,
  expectedRevision: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
});
export type ApplyCommandPayload = typeof ApplyCommandPayloadSchema.Type;
export const StorefrontIssueCodeSchema = Schema.Literals([
  'NOT_FOUND',
  'NOT_AVAILABLE',
  'VARIANT_REQUIRED',
  'OUT_OF_STOCK',
  'INSUFFICIENT_STOCK',
  'AVAILABILITY_UNKNOWN',
  'MINIMUM_QUANTITY',
  'PACKAGE_QUANTITY',
  'PRICE_CHANGED',
  'PRICE_UNAVAILABLE',
  'SHIPPING_PRICE_CHANGED',
]);
export type StorefrontIssueCode = typeof StorefrontIssueCodeSchema.Type;

export const StorefrontIssueSchema = Schema.Struct({
  availability: Schema.optionalKey(AvailabilitySchema),
  availableQuantity: Schema.optionalKey(Schema.Finite),
  code: StorefrontIssueCodeSchema,
  currentUnitPriceMinor: Schema.optionalKey(MinorAmountSchema),
  expectedUnitPriceMinor: Schema.optionalKey(MinorAmountSchema),
  message: Schema.String,
  productId: Schema.optionalKey(Schema.String),
  variantId: Schema.optionalKey(Schema.String),
});
export type StorefrontIssue = typeof StorefrontIssueSchema.Type;

export const StorefrontOrderLineResultSchema = Schema.Struct({
  lineTotalMinor: MinorAmountSchema,
  name: Schema.String,
  productId: Schema.String,
  quantity: Schema.Finite,
  sku: Schema.String,
  unitPriceMinor: MinorAmountSchema,
  variantId: Schema.optionalKey(Schema.String),
  variantName: Schema.optionalKey(Schema.String),
});

export const StorefrontOrderResultSchema = Schema.Struct({
  issues: Schema.Array(StorefrontIssueSchema),
  lines: Schema.Array(StorefrontOrderLineResultSchema),
  orderId: Schema.optionalKey(Schema.String),
  orderNumber: Schema.optionalKey(Schema.String),
  outcome: Schema.Literals(['PLACED', 'REPLAYED', 'REJECTED', 'VALID']),
  shippingPriceMinor: Schema.optionalKey(MinorAmountSchema),
  status: Schema.optionalKey(OrderStatusSchema),
  totalMinor: Schema.optionalKey(MinorAmountSchema),
  totalVatMinor: Schema.optionalKey(MinorAmountSchema),
});
export type StorefrontOrderResult = typeof StorefrontOrderResultSchema.Type;

/** Identifiers of the entities the command created or changed, in command order. */
export const ApplyCommandResultSchema = Schema.Struct({
  entityIds: Schema.Array(EntityIdSchema),
  revision: Schema.Int,
  storefrontOrder: Schema.optionalKey(StorefrontOrderResultSchema),
});
export type ApplyCommandResult = typeof ApplyCommandResultSchema.Type;
export const MerchandiseErrorSchema = Schema.Union([
  MerchandiseScopeMismatch,
  MerchandiseNotFound,
  MerchandiseLifecycleConflict,
  MerchandiseRevisionConflict,
  MerchandisePersistenceUnavailable,
  MerchandiseReferenceUnavailable,
  MerchandiseReferenceIneligible,
  MerchandisePermissionDenied,
  MerchandiseNotImplemented,
]);
export type MerchandiseError = typeof MerchandiseErrorSchema.Type;
export { MerchandiseScopeMismatch } from '../errors/merchandise-scope-mismatch.ts';
export { MerchandiseNotFound } from '../errors/merchandise-not-found.ts';
export { MerchandiseLifecycleConflict } from '../errors/merchandise-lifecycle-conflict.ts';
export { MerchandiseRevisionConflict } from '../errors/merchandise-revision-conflict.ts';
export { MerchandisePersistenceUnavailable } from '../errors/merchandise-persistence-unavailable.ts';
export { MerchandiseReferenceUnavailable } from '../errors/merchandise-reference-unavailable.ts';
export { MerchandiseReferenceIneligible } from '../errors/merchandise-reference-ineligible.ts';
export { MerchandisePermissionDenied } from '../errors/merchandise-permission-denied.ts';
export { MerchandiseNotImplemented } from '../errors/merchandise-not-implemented.ts';
