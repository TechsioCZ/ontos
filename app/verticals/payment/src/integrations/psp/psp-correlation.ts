import { Schema } from 'effect';

import type { PaymentOperationIdSchema } from '../../../shared/domain/payment-identifiers.ts';

/**
 * Deterministic provider correlation derived only from the Payment Operation id (#1156, #1158, plan D12).
 * The same operation always produces the same order reference and idempotency key, so a redelivery
 * or a replay can never mint a second provider request identity.
 */

/**
 * The operation UUID as 32 lower-case hex digits. It is the exact value of GoPay `order_number`, Comgate
 * `refId`, Stripe `metadata[ontos_order_reference]` and `payment_intent_data[metadata][ontos_order_reference]`
 * (searched as `metadata['ontos_order_reference']:'<orderReference>'`). Stripe `client_reference_id` carries
 * the dashed operation UUID for dashboard readability only; no lookup uses it.
 */
export const GatewayOrderReferenceSchema = Schema.String.check(Schema.isPattern(/^[0-9a-f]{32}$/u)).pipe(
  Schema.brand('GatewayOrderReference'),
);
export type GatewayOrderReference = typeof GatewayOrderReferenceSchema.Type;

/** Stripe `Idempotency-Key` (Stripe allows at most 255 characters). */
export const GatewayIdempotencyKeySchema = Schema.String.check(
  Schema.isMaxLength(255),
  Schema.isPattern(/^ontos-pop-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u),
).pipe(Schema.brand('GatewayIdempotencyKey'));
export type GatewayIdempotencyKey = typeof GatewayIdempotencyKeySchema.Type;

export const ProviderCorrelationSchema = Schema.Struct({
  idempotencyKey: GatewayIdempotencyKeySchema,
  orderReference: GatewayOrderReferenceSchema,
});
export type ProviderCorrelation = typeof ProviderCorrelationSchema.Type;

/** Pure: the operation id is already a decoded UUID, so both derived values always satisfy their schemas. */
export const deriveProviderCorrelation = (operationId: typeof PaymentOperationIdSchema.Type): ProviderCorrelation => {
  const canonical = operationId.toLowerCase();
  return {
    idempotencyKey: GatewayIdempotencyKeySchema.make(`ontos-pop-${canonical}`),
    orderReference: GatewayOrderReferenceSchema.make(canonical.replaceAll('-', '')),
  };
};
