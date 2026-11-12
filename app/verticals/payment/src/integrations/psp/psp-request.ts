import { Schema } from 'effect';

import { PaymentGatewayAccountBindingSchema } from '../../../shared/domain/payment-execution-binding.ts';
import {
  PaymentIdSchema,
  PaymentLegalEntityIdSchema,
  PaymentOperationIdSchema,
  PaymentTenantIdSchema,
} from '../../../shared/domain/payment-identifiers.ts';
import { PaymentPositiveMonetaryAmountSchema } from '../../../shared/domain/payment-money.ts';
import { PaymentOperationKindSchema, PaymentRefundBasisKindSchema } from '../../../shared/domain/payment-vocabulary.ts';
import {
  GatewayCredentialSecretRefSchema,
  GatewayHttpsUrlSchema,
  GatewayMerchantIdentitySchema,
  GatewayProviderAccountBindingIdSchema,
  GatewayReturnTokenSchema,
} from '../../../shared/domain/psp-configuration.ts';
import { GatewayOrderReferenceSchema, ProviderCorrelationSchema } from './psp-correlation.ts';

/**
 * Provider-neutral request contracts handed to a `GatewayProviderAdapter` (#1154, #1156). The
 * adapter never selects an account: the execution target is resolved from the immutable C16
 * operation binding before any adapter call.
 */

const credentialRevisionSchema = Schema.Finite.check(Schema.isInt(), Schema.isGreaterThanOrEqualTo(1));

/** Opaque provider object identifier (GoPay payment id, Stripe `cs_`/`pi_`/`re_` id, Comgate transId). */
export const ProviderObjectIdSchema = Schema.String.check(
  Schema.isMinLength(1),
  Schema.isMaxLength(255),
  Schema.isPattern(/^[!-~]+$/u),
).pipe(Schema.brand('ProviderObjectId'));
export type ProviderObjectId = typeof ProviderObjectIdSchema.Type;

/** A provider object, typed by what it is. Only the owning family produces and consumes its variants. */
export const ProviderObjectRefSchema = Schema.Union([
  Schema.TaggedStruct('GOPAY_PAYMENT', { id: ProviderObjectIdSchema }),
  Schema.TaggedStruct('STRIPE_CHECKOUT_SESSION', { id: ProviderObjectIdSchema }),
  Schema.TaggedStruct('STRIPE_PAYMENT_INTENT', { id: ProviderObjectIdSchema }),
  Schema.TaggedStruct('STRIPE_REFUND', { id: ProviderObjectIdSchema }),
  Schema.TaggedStruct('COMGATE_TRANSACTION', { transId: ProviderObjectIdSchema }),
]);
export type ProviderObjectRef = typeof ProviderObjectRefSchema.Type;

/**
 * Everything an adapter needs to act for one Provider Account Binding. Historical (retired)
 * bindings resolve too; a Current binding is never substituted for the recorded one (#1155).
 */
export const GatewayExecutionTargetSchema = Schema.Struct({
  binding: PaymentGatewayAccountBindingSchema,
  bindingId: GatewayProviderAccountBindingIdSchema,
  credentialRevision: credentialRevisionSchema,
  credentialSecretRef: GatewayCredentialSecretRefSchema,
  legalEntityId: PaymentLegalEntityIdSchema,
  merchantIdentity: GatewayMerchantIdentitySchema,
  notificationUrl: GatewayHttpsUrlSchema,
  /** Present only when resolved for a Customer Configuration with an enablement return URL. */
  returnUrl: Schema.Option(GatewayHttpsUrlSchema),
  tenantId: PaymentTenantIdSchema,
});
export type GatewayExecutionTarget = typeof GatewayExecutionTargetSchema.Type;

const contactText = (maximumLength: number) =>
  Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(maximumLength), Schema.isTrimmed());

/** Payer contact for providers that require it (Comgate). C16 has no owner for it yet (plan N9). */
export const GatewayPayerContactSchema = Schema.Struct({
  email: Schema.Option(contactText(254)),
  fullName: Schema.Option(contactText(200)),
  phone: Schema.Option(contactText(40)),
});
export type GatewayPayerContact = typeof GatewayPayerContactSchema.Type;

export const GatewayCollectRequestSchema = Schema.Struct({
  amount: PaymentPositiveMonetaryAmountSchema,
  correlation: ProviderCorrelationSchema,
  operationId: PaymentOperationIdSchema,
  payerContact: Schema.Option(GatewayPayerContactSchema),
  paymentId: PaymentIdSchema,
  returnToken: GatewayReturnTokenSchema,
});
export type GatewayCollectRequest = typeof GatewayCollectRequestSchema.Type;

export const GatewayCancelRequestSchema = Schema.Struct({
  operationId: PaymentOperationIdSchema,
  providerTarget: ProviderObjectRefSchema,
  targetOperationId: PaymentOperationIdSchema,
});
export type GatewayCancelRequest = typeof GatewayCancelRequestSchema.Type;

export const GatewayRefundRequestSchema = Schema.Struct({
  amount: PaymentPositiveMonetaryAmountSchema,
  correlation: ProviderCorrelationSchema,
  operationId: PaymentOperationIdSchema,
  providerTarget: ProviderObjectRefSchema,
  /** Audit only. The basis is covered by the C16 material hash, not by the adapter request hash (D13). */
  refundBasisKind: PaymentRefundBasisKindSchema,
  targetOperationId: PaymentOperationIdSchema,
});
export type GatewayRefundRequest = typeof GatewayRefundRequestSchema.Type;

/** What Payment expects the looked-up provider object to prove. */
export const GatewayExpectedEffectSchema = Schema.Struct({
  amount: PaymentPositiveMonetaryAmountSchema,
  operationId: PaymentOperationIdSchema,
  operationKind: PaymentOperationKindSchema,
});
export type GatewayExpectedEffect = typeof GatewayExpectedEffectSchema.Type;

/** Lookup by a known provider object, or (Stripe metadata search only) by the order reference. */
export const GatewayLookupTargetSchema = Schema.Union([
  Schema.TaggedStruct('PROVIDER_OBJECT', { ref: ProviderObjectRefSchema }),
  Schema.TaggedStruct('ORDER_REFERENCE', { orderReference: GatewayOrderReferenceSchema }),
]);
export type GatewayLookupTarget = typeof GatewayLookupTargetSchema.Type;

export const GatewayLookupRequestSchema = Schema.Struct({
  expected: GatewayExpectedEffectSchema,
  target: GatewayLookupTargetSchema,
});
export type GatewayLookupRequest = typeof GatewayLookupRequestSchema.Type;
