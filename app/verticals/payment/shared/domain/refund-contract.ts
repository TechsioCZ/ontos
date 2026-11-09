import { Schema } from 'effect';

import {
  PaymentRevisionSchema,
  PaymentSourceAuthorityIdSchema,
  PaymentSourceEnvironmentSchema,
  PaymentSourceSystemSchema,
} from './payment-identifiers.ts';
import { PaymentSourceKindSchema } from './payment-vocabulary.ts';
import { PaymentCancellationConflict } from './refund-cancellation-conflict.ts';
import { PaymentCancellationRejected } from './refund-cancellation-rejected.ts';
import { PaymentCancellationUnavailable } from './refund-cancellation-unavailable.ts';
import { PaymentRefundConflict } from './refund-conflict.ts';
import { PaymentRefundRejected } from './refund-rejected.ts';
import { PaymentRefundUnavailable } from './refund-unavailable.ts';

/**
 * Public contract of cancellation and refund requests (#1150): the governed refund execution route
 * and the exact typed refusals of `request-payment-cancellation` and `request-payment-refund`.
 */

/** How the configured executor of a REFUND is selected from the original collection method (#1150/#1152). */
export const PAYMENT_REFUND_ROUTE_KINDS = [
  /** ONLINE_GATEWAY: the original provider/account/environment binding through C17; never another account. */
  'ORIGINAL_GATEWAY_BINDING',
  /** Bank transfer, deferred invoice and COD: the configured merchant bank/accounting refund route. */
  'BANK_ACCOUNTING',
  /** Pickup/on-site: the configured POS/local refund route. */
  'LOCAL_POS',
  /** Pickup/on-site without a POS route: an explicitly authorized bank or manual external refund route. */
  'MANUAL_EXTERNAL',
] as const;
export const PaymentRefundRouteKindSchema = Schema.Literals(PAYMENT_REFUND_ROUTE_KINDS);
export type PaymentRefundRouteKind = typeof PaymentRefundRouteKindSchema.Type;

const routeAccountRef = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(200), Schema.isTrimmed());

/**
 * The configured refund executor that received the request. The destination of returned funds is
 * established by that executor under its own governed contract; it is never caller-supplied.
 */
export const PaymentRefundExecutionRouteSchema = Schema.Struct({
  accountRef: routeAccountRef.pipe(Schema.brand('PaymentRefundRouteAccountRef'), Schema.decodeTo(routeAccountRef)),
  environment: PaymentSourceEnvironmentSchema,
  routeKind: PaymentRefundRouteKindSchema,
  sourceAuthorityId: PaymentSourceAuthorityIdSchema,
  sourceAuthorityRevision: PaymentRevisionSchema,
  sourceKind: PaymentSourceKindSchema,
  sourceSystem: PaymentSourceSystemSchema,
});
export type PaymentRefundExecutionRoute = typeof PaymentRefundExecutionRouteSchema.Type;

/** Every typed refusal of `request-payment-refund`. */
export const PaymentRefundFailureSchema = Schema.Union([
  PaymentRefundRejected,
  PaymentRefundConflict,
  PaymentRefundUnavailable,
]);
export type PaymentRefundFailure = typeof PaymentRefundFailureSchema.Type;

/** Every typed refusal of `request-payment-cancellation`. */
export const PaymentCancellationFailureSchema = Schema.Union([
  PaymentCancellationRejected,
  PaymentCancellationConflict,
  PaymentCancellationUnavailable,
]);
export type PaymentCancellationFailure = typeof PaymentCancellationFailureSchema.Type;
