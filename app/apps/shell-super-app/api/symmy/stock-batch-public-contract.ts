import { SymmyItemOutcomeSchema } from '@app/shared-contracts/symmy';
import { SymmyStockRowSchema, SymmyStockRowsSchema } from '@app/symmy-integration/symmy-internal-contracts';
import type { SymmyStockRows } from '@app/symmy-integration/symmy-internal-contracts';
import { DateTime, Result, Schema } from 'effect';

import type { SymmyStockBatchRequest } from './stock-batch-request-contract.ts';

/**
 * The public body of `POST /inventory/stock/batch`: one result per submitted row, in request order.
 * `itemKey` and `locationKey` repeat the submitted row, so a result matches by key as well as by position.
 */
export const SymmyStockBatchResponseSchema = Schema.Struct({
  items: Schema.NonEmptyArray(
    Schema.Struct({
      ...SymmyItemOutcomeSchema.fields,
      itemKey: SymmyStockRowSchema.fields.itemKey,
      locationKey: SymmyStockRowSchema.fields.locationKey,
      outcome: Schema.Literals(['accepted', 'partial', 'not_accepted']),
    }),
  ),
});

/**
 * The public rows as the owner admission receives them. The route never sends a contract version, an
 * assertion identity, the receiving time or any scope fact: the enrollment and the admission derive those.
 */
export const mapSymmyStockBatchRequest = ({ stock }: SymmyStockBatchRequest): SymmyStockRows =>
  Result.getOrThrow(
    Schema.decodeUnknownResult(SymmyStockRowsSchema)(
      stock.map((row) => ({
        ...row,
        businessObservedAt: DateTime.formatIso(row.businessObservedAt),
      })),
    ),
  );
