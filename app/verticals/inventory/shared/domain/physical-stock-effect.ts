import { Schema } from 'effect';

import { CustomerConfigurationIdSchema, InventoryBackendSchema } from '../inventory-launch-scope.ts';
import { InventoryBackendConfigurationRefSchema } from '../resources/inventory-backend-configuration.ts';
import { StockItemRefSchema } from '../resources/stock-item.ts';
import { StockLocationRefSchema } from '../resources/stock-location.ts';
import { StockPositionRefSchema } from '../resources/stock-position.ts';
import { InventoryBackendIdSchema } from './inventory-backend-identifiers.ts';
import { PhysicalStockEffectConflict } from './physical-stock-effect-conflict.ts';
import {
  PhysicalStockEffectIndeterminate,
  PhysicalStockEffectIndeterminateReasonSchema,
} from './physical-stock-effect-indeterminate.ts';
import { PhysicalStockEffectUnavailable } from './physical-stock-effect-unavailable.ts';
import { StockQuantitySchema } from './stock-position.ts';

const boundedText = Schema.String.check(Schema.isTrimmed(), Schema.isMinLength(1), Schema.isMaxLength(300));
const instant = Schema.toEncoded(Schema.DateTimeUtcFromString);
const uuid = Schema.String.check(Schema.isUUID());
export const ActionInvocationIdSchema = uuid.pipe(Schema.brand('ActionInvocationId'));
export const LegalEntityIdSchema = uuid.pipe(Schema.brand('LegalEntityId'));

export const PhysicalStockEffectIdSchema = uuid.pipe(Schema.brand('PhysicalStockEffectId'));
export type PhysicalStockEffectId = typeof PhysicalStockEffectIdSchema.Type;

export const PhysicalStockEffectKindSchema = Schema.Literals(['RECEIPT', 'ISSUE']);
export type PhysicalStockEffectKind = typeof PhysicalStockEffectKindSchema.Type;

export const PhysicalStockBusinessReasonSchema = Schema.Struct({
  code: boundedText,
  reference: boundedText,
});

export const PositiveExactStockQuantityAmountSchema = StockQuantitySchema.fields.amount.check(
  Schema.makeFilter((amount) =>
    amount === '0' ? 'Physical Stock Receipt/Issue Quantity must be greater than zero' : undefined,
  ),
);
export const PhysicalStockEffectQuantitySchema = Schema.Struct({
  amount: PositiveExactStockQuantityAmountSchema,
  unitRef: StockQuantitySchema.fields.unitRef,
});

export const PhysicalStockEffectPayloadSchema = Schema.Struct({
  customerConfigurationId: CustomerConfigurationIdSchema,
  effectId: PhysicalStockEffectIdSchema,
  positionRef: StockPositionRefSchema,
  quantity: PhysicalStockEffectQuantitySchema,
  reason: PhysicalStockBusinessReasonSchema,
  stockItemRef: StockItemRefSchema,
});
export type PhysicalStockEffectPayload = typeof PhysicalStockEffectPayloadSchema.Type;

export const PhysicalStockEffectRequestSchema = Schema.Struct({
  actionInvocationId: ActionInvocationIdSchema,
  backend: InventoryBackendSchema,
  backendConfigurationRef: InventoryBackendConfigurationRefSchema,
  backendId: InventoryBackendIdSchema,
  customerConfigurationId: CustomerConfigurationIdSchema,
  effectId: PhysicalStockEffectIdSchema,
  kind: PhysicalStockEffectKindSchema,
  legalEntityId: LegalEntityIdSchema,
  positionRef: StockPositionRefSchema,
  quantity: PhysicalStockEffectQuantitySchema,
  reason: PhysicalStockBusinessReasonSchema,
  requestedAt: instant,
  stockItemRef: StockItemRefSchema,
  stockLocationRef: StockLocationRefSchema,
});
export type PhysicalStockEffectRequest = typeof PhysicalStockEffectRequestSchema.Type;

export const PhysicalStockEffectEvidenceSchema = Schema.Struct({
  appliedAt: instant,
  backend: InventoryBackendSchema,
  backendConfigurationRef: InventoryBackendConfigurationRefSchema,
  backendEvidenceRef: boundedText,
  backendId: InventoryBackendIdSchema,
  effectId: PhysicalStockEffectIdSchema,
  issuer: boundedText,
  kind: PhysicalStockEffectKindSchema,
  positionRef: StockPositionRefSchema,
  quantity: PhysicalStockEffectQuantitySchema,
});
export type PhysicalStockEffectEvidence = typeof PhysicalStockEffectEvidenceSchema.Type;

export const RequestedPhysicalStockEffectSchema = Schema.TaggedStruct('REQUESTED', {
  request: PhysicalStockEffectRequestSchema,
});
export const AppliedPhysicalStockEffectSchema = Schema.TaggedStruct('APPLIED', {
  evidence: PhysicalStockEffectEvidenceSchema,
  request: PhysicalStockEffectRequestSchema,
});
export const RejectedPhysicalStockEffectSchema = Schema.TaggedStruct('REJECTED', {
  reason: Schema.Literals(['INSUFFICIENT_ON_HAND', 'POSITION_REJECTED', 'BACKEND_REJECTED']),
  request: PhysicalStockEffectRequestSchema,
});
export const IndeterminatePhysicalStockEffectSchema = Schema.TaggedStruct('INDETERMINATE', {
  reason: PhysicalStockEffectIndeterminateReasonSchema,
  request: PhysicalStockEffectRequestSchema,
});
export const PhysicalStockEffectRecordSchema = Schema.Union([
  RequestedPhysicalStockEffectSchema,
  AppliedPhysicalStockEffectSchema,
  RejectedPhysicalStockEffectSchema,
  IndeterminatePhysicalStockEffectSchema,
]);
export type PhysicalStockEffectRecord = typeof PhysicalStockEffectRecordSchema.Type;

export const RequestPhysicalStockEffectResultSchema = Schema.Struct({
  effect: PhysicalStockEffectRecordSchema,
  outcome: Schema.Literals(['REQUESTED', 'EXACT_REPLAY']),
});
export type RequestPhysicalStockEffectResult = typeof RequestPhysicalStockEffectResultSchema.Type;

export class PhysicalStockEffectRejected extends Schema.TaggedError<PhysicalStockEffectRejected>()(
  'PhysicalStockEffectRejected',
  {
    code: Schema.Literal('physical_stock_effect_rejected'),
    effectId: PhysicalStockEffectIdSchema,
    reason: Schema.Literals([
      'BACKEND_CONFIGURATION_MISSING',
      'BACKEND_CONFIGURATION_MISMATCH',
      'BACKEND_REJECTED',
      'INSUFFICIENT_ON_HAND',
      'POSITION_NOT_CURRENT',
      'POSITION_NOT_FOUND',
      'POSITION_REJECTED',
      'STOCK_ITEM_MISMATCH',
      'TENANT_SCOPE_MISMATCH',
      'UNIT_MISMATCH',
      'WORKER_CONTEXT_MISMATCH',
    ]),
  },
) {}

export const PhysicalStockEffectErrorSchema = Schema.Union([
  PhysicalStockEffectConflict,
  PhysicalStockEffectRejected,
  PhysicalStockEffectUnavailable,
  PhysicalStockEffectIndeterminate,
]);

export { PhysicalStockEffectConflict } from './physical-stock-effect-conflict.ts';
export { PhysicalStockEffectIndeterminate } from './physical-stock-effect-indeterminate.ts';
export { PhysicalStockEffectUnavailable } from './physical-stock-effect-unavailable.ts';
