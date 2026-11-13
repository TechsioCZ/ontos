import { Option, Schema } from 'effect';

import { PaymentGatewayAccountBindingSchema } from '../../../shared/domain/payment-execution-binding.ts';
import type { PaymentPayerContact } from '../../../shared/domain/payment-payer-contact.ts';
import {
  PaymentIdSchema,
  PaymentLegalEntityIdSchema,
  PaymentOperationIdSchema,
  PaymentTenantIdSchema,
} from '../../../shared/domain/payment-identifiers.ts';
import { PaymentPositiveMonetaryAmountSchema } from '../../../shared/domain/payment-money.ts';
import { PaymentRefundBasisKindSchema } from '../../../shared/domain/payment-vocabulary.ts';
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
 * The credential is always the binding's current ACTIVE revision at resolution time: a rotation
 * authenticates the same account (#1158), so replay, lookup and notification after a rotation use
 * the new revision of the same binding, never another binding.
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

/**
 * Payer contact handed to a provider adapter for providers that require it (Comgate). Its source is
 * the caller-supplied `PaymentPayerContact` on the start-payment-collection Action (plan D-P3, N9), converted
 * by `toGatewayPayerContact` during dispatch preparation only.
 */
export const GatewayPayerContactSchema = Schema.Struct({
  email: Schema.Option(contactText(254)),
  fullName: Schema.Option(contactText(200)),
  phone: Schema.Option(contactText(40)),
});
export type GatewayPayerContact = typeof GatewayPayerContactSchema.Type;

/** Converts the Action's payer contact into the adapter contract; absent fields become `Option.none()`. */
export const toGatewayPayerContact = (contact: PaymentPayerContact): GatewayPayerContact => ({
  email: Option.fromUndefinedOr(contact.email),
  fullName: Option.fromUndefinedOr(contact.fullName),
  phone: Option.fromUndefinedOr(contact.phone),
});

/**
 * Every input of a prepare is explicit, so preparation is a pure function of it. The executor calls
 * prepare only when the ledger holds no prepared request for the operation (plan §2.1); a redelivery
 * reuses the persisted request and never prepares again.
 */
export const GatewayCollectRequestSchema = Schema.Struct({
  amount: PaymentPositiveMonetaryAmountSchema,
  correlation: ProviderCorrelationSchema,
  /** Fixed by the executor before prepare; Stripe `expires_at` = issuedAt + 24 h. */
  issuedAt: Schema.DateTimeUtc,
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

/** The collection a cancel acts on, with the amount a provider "already paid" answer must prove. */
export const GatewayCancelTargetSchema = Schema.Struct({
  amount: PaymentPositiveMonetaryAmountSchema,
  operationId: PaymentOperationIdSchema,
});

/**
 * The Payment Operation(s) a send, replay or lookup may report on, tagged by operation kind. An adapter
 * emits findings only for `operationId` and, for CANCEL_OR_VOID, for `target.operationId` (e.g.
 * CANCEL_NOT_EFFECTED plus COLLECTION_CONFIRMED when the collection was already paid). It never
 * invents a target for another provider object.
 */
export const GatewayExpectedEffectSchema = Schema.Union([
  Schema.TaggedStruct('COLLECT', {
    amount: PaymentPositiveMonetaryAmountSchema,
    operationId: PaymentOperationIdSchema,
  }),
  Schema.TaggedStruct('REFUND', { amount: PaymentPositiveMonetaryAmountSchema, operationId: PaymentOperationIdSchema }),
  Schema.TaggedStruct('CANCEL_OR_VOID', { operationId: PaymentOperationIdSchema, target: GatewayCancelTargetSchema }),
]);
export type GatewayExpectedEffect = typeof GatewayExpectedEffectSchema.Type;

/**
 * Lookup by a known provider object, or by the order reference. ORDER_REFERENCE is Stripe PaymentIntent
 * search only; GoPay and Comgate have no documented order-reference lookup and fail it with
 * `GatewayProviderUnsupported`.
 */
export const GatewayLookupTargetSchema = Schema.Union([
  Schema.TaggedStruct('PROVIDER_OBJECT', { ref: ProviderObjectRefSchema }),
  Schema.TaggedStruct('ORDER_REFERENCE', { orderReference: GatewayOrderReferenceSchema }),
]);
export type GatewayLookupTarget = typeof GatewayLookupTargetSchema.Type;

/**
 * The provider refund-history rows a payment had before a refund dispatch was sent (GoPay: its history rows name
 * no request and carry date-only dates). Read through the dispatch's binding before the send and persisted with
 * the prepared request, so a later lookup can attribute the one row that is new since then.
 */
export const GatewayRefundBaselineSchema = Schema.Struct({
  rowIds: Schema.Array(ProviderObjectIdSchema).check(Schema.isMaxLength(1000)),
});
export type GatewayRefundBaseline = typeof GatewayRefundBaselineSchema.Type;

export const GatewayLookupRequestSchema = Schema.Struct({
  /**
   * The refund baseline of a REFUND dispatch the provider acknowledged with its own dispatch response
   * (`acknowledgedRefundBaselineOf`). None for any other dispatch, including one whose response was lost: a row
   * that is new since the baseline proves that dispatch only when the provider accepted it.
   */
  acknowledgedRefundBaseline: Schema.Option(GatewayRefundBaselineSchema),
  /**
   * The ledger `preparedAt` of the expected operation's dispatch (Comgate statement dates). None when the
   * operation was never prepared.
   */
  dispatchedAt: Schema.Option(Schema.DateTimeUtc),
  expected: GatewayExpectedEffectSchema,
  target: GatewayLookupTargetSchema,
});
export type GatewayLookupRequest = typeof GatewayLookupRequestSchema.Type;
