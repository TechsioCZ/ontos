import { SymmyItemOutcomeSchema } from '@app/shared-contracts/symmy';
import { SymmyCustomerGroupRowSchema } from '@app/symmy-integration/symmy-internal-contracts';
import { Schema } from 'effect';

/**
 * The public body of a `POST /customer-groups/batch` answer: one result per submitted group, in request order, each
 * with the true owner outcome of its create or update. `code` repeats the submitted group, so a result matches by
 * code as well as by position.
 */
export const SymmyCustomerGroupsBatchResponseSchema = Schema.Struct({
  items: Schema.NonEmptyArray(
    Schema.Struct({
      ...SymmyItemOutcomeSchema.fields,
      code: SymmyCustomerGroupRowSchema.fields.code,
      outcome: Schema.Literals(['accepted', 'partial', 'not_accepted']),
    }),
  ),
});
