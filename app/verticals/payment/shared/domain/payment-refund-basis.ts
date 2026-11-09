import { Schema } from 'effect';

import {
  PaymentEvidenceRefSchema,
  PaymentOrderCommitmentAttemptIdSchema,
  PaymentRefundableItemRefSchema,
} from './payment-identifiers.ts';
import { PaymentCurrencySchema, PaymentPositiveAmountMinorSchema } from './payment-money.ts';

export const PAYMENT_MAXIMUM_REFUNDABLE_ITEMS = 1000;

/**
 * One complete authoritative refundable item supplied by the Order/Claim/Aftercare owner (#1150 A).
 * Payment never fractions it: the item amount is atomic for Payment.
 */
export const PaymentRefundableItemSchema = Schema.Struct({
  amountMinor: PaymentPositiveAmountMinorSchema,
  currency: PaymentCurrencySchema,
  itemRef: PaymentRefundableItemRefSchema,
  sourceEvidenceRef: PaymentEvidenceRefSchema,
});
export type PaymentRefundableItem = typeof PaymentRefundableItemSchema.Type;

const distinctItemRefs = Schema.makeFilter((items: readonly PaymentRefundableItem[]) =>
  new Set(items.map((item) => item.itemRef)).size === items.length
    ? undefined
    : 'Refundable items must be distinct complete items',
);

export const PaymentRefundableItemsBasisSchema = Schema.TaggedStruct('REFUNDABLE_ITEMS', {
  items: Schema.NonEmptyArray(PaymentRefundableItemSchema).check(
    Schema.isMaxLength(PAYMENT_MAXIMUM_REFUNDABLE_ITEMS),
    distinctItemRefs,
  ),
});
export type PaymentRefundableItemsBasis = typeof PaymentRefundableItemsBasisSchema.Type;

/**
 * Exact remaining collected amount after authoritative terminal non-commit plus closure against late
 * commit (#1150 B). Timeout, unknown or lost Order outcome can never construct this basis.
 */
export const PaymentFailedCommitmentCompensationBasisSchema = Schema.TaggedStruct('FAILED_COMMITMENT_COMPENSATION', {
  attemptRef: PaymentOrderCommitmentAttemptIdSchema,
  closedAgainstLateCommit: Schema.Literal(true),
  terminalNonCommitEvidenceRef: PaymentEvidenceRefSchema,
});
export type PaymentFailedCommitmentCompensationBasis = typeof PaymentFailedCommitmentCompensationBasisSchema.Type;

/** Exactly one immutable basis per REFUND; mixing or switching bases is not representable. */
export const PaymentRefundBasisSchema = Schema.Union([
  PaymentRefundableItemsBasisSchema,
  PaymentFailedCommitmentCompensationBasisSchema,
]);
export type PaymentRefundBasis = typeof PaymentRefundBasisSchema.Type;
