import { Schema } from 'effect';

import {
  InventorySourceImportOutcomeSchema,
  InventorySourceImportUnavailable,
} from '../domain/inventory-source-import-outcome.ts';
import { InventorySourceAssertionProposalSchema } from '../domain/inventory-source-assertion.ts';
import { StockPositionRefSchema } from '../resources/stock-position.ts';

const sameRef = (left: typeof StockPositionRefSchema.Type, right: typeof StockPositionRefSchema.Type) =>
  left.moduleId === right.moduleId &&
  left.resourceId === right.resourceId &&
  left.resourceType === right.resourceType &&
  left.tenantId === right.tenantId;

export const ImportSourceAssertionPayloadSchema = Schema.Struct({
  authorizationTargetRef: StockPositionRefSchema,
  items: Schema.Array(InventorySourceAssertionProposalSchema).check(Schema.isMinLength(1), Schema.isMaxLength(100)),
}).check(
  Schema.makeFilter(({ authorizationTargetRef, items }) =>
    items.every(({ positionRef }) => sameRef(positionRef, authorizationTargetRef))
      ? undefined
      : 'Every Inventory Source Assertion in a batch must share the exact authorization target Position',
  ),
);
export type ImportSourceAssertionPayload = typeof ImportSourceAssertionPayloadSchema.Type;

const nonNegativeInt = Schema.Number.check(Schema.isInt(), Schema.isGreaterThanOrEqualTo(0));

export const InventorySourceImportBatchSummarySchema = Schema.Struct({
  accepted: nonNegativeInt,
  allItemsDeterminate: Schema.Boolean,
  duplicates: nonNegativeInt,
  indeterminate: nonNegativeInt,
  rejected: nonNegativeInt,
  stale: nonNegativeInt,
});
export type InventorySourceImportBatchSummary = typeof InventorySourceImportBatchSummarySchema.Type;

export const ImportSourceAssertionResultSchema = Schema.Struct({
  items: Schema.Array(InventorySourceImportOutcomeSchema),
  summary: InventorySourceImportBatchSummarySchema,
});
export type ImportSourceAssertionResult = typeof ImportSourceAssertionResultSchema.Type;

export class InventorySourceImportRequestRejected extends Schema.TaggedError<InventorySourceImportRequestRejected>()(
  'InventorySourceImportRequestRejected',
  {
    code: Schema.Literal('inventory_source_import_request_rejected'),
    reason: Schema.Literals([
      'Every Inventory Source Assertion must belong to the trusted Tenant',
      'Every Inventory Source Assertion must match the exact authorization target Position',
    ]),
  },
) {}

export const ImportSourceAssertionErrorSchema = Schema.Union([
  InventorySourceImportRequestRejected,
  InventorySourceImportUnavailable,
]);
