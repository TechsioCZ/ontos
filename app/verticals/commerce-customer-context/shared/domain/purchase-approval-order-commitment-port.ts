/**
 * Public Order-owner boundary for final approval consumption.
 *
 * The Order owner calls this seam only after its Order commit is durable.  It
 * supplies the exact immutable proposal/decision bundle and commitment id;
 * commerce-customer-context remains the only writer of the approval aggregate
 * and performs the single-use CAS in its owner routine.
 */
// oxlint-disable-next-line max-classes-per-file -- The public port intentionally colocates its tagged owner-unavailable failure with the Context service tag; expires: 2027-09-10.
import type { Effect } from 'effect';
import { Context, Schema } from 'effect';
import type {
  ConsumePurchaseApprovalInputSchema,
  ConsumePurchaseApprovalResultSchema,
  PurchasingApprovalRejected,
} from './purchasing-approval.ts';

export type PurchaseApprovalOrderCommitmentInput = Schema.Schema.Type<typeof ConsumePurchaseApprovalInputSchema>;
export type PurchaseApprovalOrderCommitmentResult = Schema.Schema.Type<typeof ConsumePurchaseApprovalResultSchema>;

export class PurchaseApprovalOrderOwnerUnavailable extends Schema.TaggedError<PurchaseApprovalOrderOwnerUnavailable>()(
  'PurchaseApprovalOrderOwnerUnavailable',
  {
    code: Schema.Literal('purchase_approval_order_owner_unavailable'),
    reason: Schema.String,
  },
) {}

export interface PurchaseApprovalOrderCommitmentPort {
  /**
   * Reconcile a committed Order exactly once. The invocation id is supplied by
   * Core and is persisted with the owner mutation for audit/idempotency.
   */
  readonly consume: (
    input: PurchaseApprovalOrderCommitmentInput,
    actionInvocationId: string,
  ) => Effect.Effect<
    PurchaseApprovalOrderCommitmentResult,
    PurchasingApprovalRejected | PurchaseApprovalOrderOwnerUnavailable
  >;
}

export class PurchaseApprovalOrderCommitment extends Context.Service<
  PurchaseApprovalOrderCommitment,
  PurchaseApprovalOrderCommitmentPort
>()(
  '@app/commerce-customer-context/shared/domain/purchase-approval-order-commitment-port/PurchaseApprovalOrderCommitment',
) {}
