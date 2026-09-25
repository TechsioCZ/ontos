import { Schema } from 'effect';

const InventorySourceAssertionIdSchema = Schema.String.check(Schema.isUUID()).pipe(
  Schema.brand('InventorySourceAssertionId'),
);

export class InventorySourceAssertionRejected extends Schema.TaggedError<InventorySourceAssertionRejected>()(
  'InventorySourceAssertionRejected',
  {
    assertionId: InventorySourceAssertionIdSchema,
    code: Schema.Literal('inventory_source_assertion_rejected'),
    reason: Schema.Literals([
      'ASSERTION_ID_CONFLICT',
      'AUTHORITY_SCOPE_MISMATCH',
      'CORRELATION_AMBIGUOUS',
      'CORRELATION_AUTHORITY_MISMATCH',
      'CORRELATION_NOT_FOUND',
      'COVERAGE_EFFECT_NOT_FOUND',
      'INVALID_ASSERTION',
      'POSITION_NOT_FOUND',
      'POSITION_SCOPE_MISMATCH',
    ]),
  },
) {}
