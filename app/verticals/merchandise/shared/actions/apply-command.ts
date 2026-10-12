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
  EntityIdSchema,
  MinorAmountSchema,
  OpportunityIdSchema,
  OrderIdSchema,
  OrderStatusSchema,
  PartyIdSchema,
  ProductIdSchema,
  ProductUnitSchema,
  VatRateSchema,
} from '../domain/merchandise-model.ts';

export const ProductPatchSchema = Schema.Struct({
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

export const OrderLineRequestSchema = Schema.Struct({
  productId: ProductIdSchema,
  quantity: Schema.Int.check(Schema.isGreaterThanOrEqualTo(1)),
});

/**
 * Commands. Server-assigned identities: CreateProduct and RecordStockMovement take the invocation id.
 * CreateOrder carries a caller-supplied id so seeds and retries can reference it deterministically.
 * The server snapshots name, SKU, unit price and VAT onto each order line at creation (req. 7d).
 * ORDER stock movements are written only by CreateOrder, so RecordStockMovement accepts manual reasons only.
 */
export const MerchandiseCommandSchema = Schema.Union([
  Schema.TaggedStruct('CreateProduct', {
    active: Schema.Boolean,
    category: Schema.Trim.check(Schema.isMinLength(1), Schema.isMaxLength(120)),
    lowStockThreshold: MinorAmountSchema,
    name: Schema.Trim.check(Schema.isMinLength(1), Schema.isMaxLength(200)),
    priceMinor: MinorAmountSchema,
    sku: Schema.Trim.check(Schema.isMinLength(1), Schema.isMaxLength(64)),
    unit: ProductUnitSchema,
    vatRate: VatRateSchema,
  }),
  Schema.TaggedStruct('UpdateProduct', {
    id: ProductIdSchema,
    patch: ProductPatchSchema,
  }),
  Schema.TaggedStruct('ChangePrice', {
    id: ProductIdSchema,
    priceMinor: MinorAmountSchema,
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
  }),
  Schema.TaggedStruct('CreateOrder', {
    id: OrderIdSchema,
    lines: Schema.Array(OrderLineRequestSchema).check(Schema.isMinLength(1), Schema.isMaxLength(200)),
    opportunityId: Schema.optionalKey(OpportunityIdSchema),
    partyId: PartyIdSchema,
  }),
  Schema.TaggedStruct('ChangeOrderStatus', {
    id: OrderIdSchema,
    status: OrderStatusSchema,
  }),
]);
export type MerchandiseCommand = typeof MerchandiseCommandSchema.Type;
export const ApplyCommandPayloadSchema = Schema.Struct({
  command: MerchandiseCommandSchema,
  expectedRevision: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
});
export type ApplyCommandPayload = typeof ApplyCommandPayloadSchema.Type;
/** Identifiers of the entities the command created or changed, in command order. */
export const ApplyCommandResultSchema = Schema.Struct({
  entityIds: Schema.Array(EntityIdSchema),
  revision: Schema.Int,
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
