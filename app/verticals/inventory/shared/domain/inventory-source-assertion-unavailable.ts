import { Schema } from 'effect';

const InventorySourceAssertionIdSchema = Schema.String.check(Schema.isUUID()).pipe(
  Schema.brand('InventorySourceAssertionId'),
);

export class InventorySourceAssertionUnavailable extends Schema.TaggedError<InventorySourceAssertionUnavailable>()(
  'InventorySourceAssertionUnavailable',
  {
    assertionId: Schema.optionalKey(InventorySourceAssertionIdSchema),
    code: Schema.Literal('inventory_source_assertion_unavailable'),
    reason: Schema.Literal('Inventory Source Assertion dependency is temporarily unavailable'),
    retryable: Schema.Literal(true),
  },
) {}
