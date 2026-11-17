import { InventorySourceAssertionProposalSchema } from '@app/inventory/source-assertion';
import { Schema } from 'effect';

const boundedText = Schema.String.check(Schema.isTrimmed(), Schema.isMinLength(1), Schema.isMaxLength(300));
const StockItemKeySchema = boundedText.pipe(Schema.brand('SymmyStockItemKey'));
const StockLocationKeySchema = boundedText.pipe(Schema.brand('SymmyStockLocationKey'));

/**
 * One absolute on-hand figure for one Symmy stock item at one Symmy stock location.
 * The identifier kinds, the meaning and the route scope are fixed by the route, never sent.
 * Every field is required and none is nullable. A reserved quantity does not exist.
 */
const SymmyStockRowSchema = Schema.Struct({
  businessObservedAt: Schema.DateTimeUtcFromString,
  itemKey: StockItemKeySchema,
  locationKey: StockLocationKeySchema,
  quantity: InventorySourceAssertionProposalSchema.fields.quantity,
  revision: boundedText,
  sourceReference: InventorySourceAssertionProposalSchema.fields.sourceReference,
});

/** The public body of `POST /inventory/stock/batch`: one to sixteen rows. */
export const SymmyStockBatchRequestSchema = Schema.Struct({
  stock: Schema.NonEmptyArray(SymmyStockRowSchema).check(Schema.isMaxLength(16)),
});
export type SymmyStockBatchRequest = typeof SymmyStockBatchRequestSchema.Type;
