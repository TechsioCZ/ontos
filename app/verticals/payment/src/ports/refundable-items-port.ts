import { Context, Effect, Schema } from 'effect';

import { PaymentRefundableItemRefSchema } from '../../shared/domain/payment-identifiers.ts';
import { PaymentRefundableItemSchema } from '../../shared/domain/payment-refund-basis.ts';
import { ownerEvidenceUnavailable } from './owner-evidence-unavailable.ts';
import type { PaymentOwnerEvidenceUnavailable, PaymentOwnerScope } from './owner-evidence-unavailable.ts';

export const PAYMENT_ITEM_NOT_REFUNDABLE_REASONS = [
  'ITEM_NOT_FOUND',
  'ITEM_NOT_REFUNDABLE',
  'PURCHASE_NOT_ACCEPTED',
] as const;
export const PaymentItemNotRefundableReasonSchema = Schema.Literals(PAYMENT_ITEM_NOT_REFUNDABLE_REASONS);

/** Authoritative per-item verdict from the Order/Claim/Aftercare owner; Payment never decomposes items. */
export const PaymentRefundableItemVerificationSchema = Schema.Union([
  Schema.TaggedStruct('REFUNDABLE', { item: PaymentRefundableItemSchema }),
  Schema.TaggedStruct('NOT_REFUNDABLE', {
    itemRef: PaymentRefundableItemRefSchema,
    reason: PaymentItemNotRefundableReasonSchema,
  }),
]);
export type PaymentRefundableItemVerification = typeof PaymentRefundableItemVerificationSchema.Type;

export interface PaymentRefundableItemsService {
  /** One verdict per requested item reference, in request order. */
  readonly verifyRefundableItems: (input: {
    readonly itemRefs: readonly [string, ...string[]];
    readonly purchaseCorrelationId: string;
    readonly scope: PaymentOwnerScope;
  }) => Effect.Effect<readonly PaymentRefundableItemVerification[], PaymentOwnerEvidenceUnavailable>;
}

/** Order/Claim/Aftercare authoritative refundable items (L4). */
export class RefundableItemsPort extends Context.Service<RefundableItemsPort, PaymentRefundableItemsService>()(
  '@app/payment/ports/refundable-items-port/RefundableItemsPort',
) {}

export const unavailableRefundableItems: PaymentRefundableItemsService = Object.freeze({
  verifyRefundableItems: () =>
    Effect.fail(ownerEvidenceUnavailable('REFUNDABLE_ITEMS', 'No authoritative refundable-items route is configured')),
});
