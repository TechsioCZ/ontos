import { ProductUnitRefSchema } from '@app/catalog-selection-contracts/resources/product-unit';
import { InventorySourceAssertionProposalSchema } from '@app/inventory/source-assertion';
import { SymmyStockRowSchema } from '@app/symmy-integration/symmy-internal-contracts';
import { Schema } from 'effect';

const boundedText = Schema.String.check(Schema.isTrimmed(), Schema.isMinLength(1), Schema.isMaxLength(300));

/**
 * One absolute on-hand figure for one Symmy stock item at one Symmy stock location.
 * The identifier kinds, the meaning and the route scope are fixed by the route, never sent.
 * Every field is required and none is nullable. A reserved quantity does not exist.
 */
const SymmyPublicStockRowSchema = Schema.Struct({
  businessObservedAt: Schema.DateTimeUtcFromString,
  itemKey: SymmyStockRowSchema.fields.itemKey,
  locationKey: SymmyStockRowSchema.fields.locationKey,
  quantity: Schema.Struct({
    amount: InventorySourceAssertionProposalSchema.fields.quantity.fields.amount,
    unitId: ProductUnitRefSchema.fields.resourceId,
  }),
  revision: boundedText,
  sourceReference: InventorySourceAssertionProposalSchema.fields.sourceReference,
});

/** The public body of `PUT /inventory/stock/batch`: one to sixteen rows. */
export const SymmyStockBatchRequestSchema = Schema.Struct({
  stock: Schema.NonEmptyArray(SymmyPublicStockRowSchema).check(Schema.isMaxLength(16)),
});
export type SymmyStockBatchRequest = typeof SymmyStockBatchRequestSchema.Type;
