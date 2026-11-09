import { Schema } from 'effect';

import {
  PaymentDeliveryOfferRefSchema,
  PaymentEvidenceRefSchema,
  PaymentPickupCapabilityRefSchema,
  PaymentProviderAccountRefSchema,
  PaymentSourceEnvironmentSchema,
  PaymentSourceSystemSchema,
} from './payment-identifiers.ts';
import { PaymentGatewayProviderFamilySchema } from './payment-vocabulary.ts';

/**
 * Immutable method-specific execution binding of one Payment intent (#1148). Configuration changes,
 * credential rotation or gateway disablement never rewrite it; recovery and refunds reuse it and
 * never fail over to another provider/account/environment (#1151).
 */
export const PaymentGatewayAccountBindingSchema = Schema.TaggedStruct('GATEWAY_ACCOUNT', {
  environment: PaymentSourceEnvironmentSchema,
  providerAccountRef: PaymentProviderAccountRefSchema,
  providerFamily: PaymentGatewayProviderFamilySchema,
});
export type PaymentGatewayAccountBinding = typeof PaymentGatewayAccountBindingSchema.Type;

/** Bank transfer in advance and deferred invoice: receipt is evidenced by configured bank/accounting authority. */
export const PaymentBankAccountingReceiptBindingSchema = Schema.TaggedStruct('BANK_ACCOUNTING_RECEIPT', {});

/**
 * The carrier/shipping-service source binding the Delivery owner confirmed for the selected offer. Only
 * this exact CARRIER source may evidence the COD customer collection (#1152 "Authority by fact family").
 */
export const PaymentCodCarrierSchema = Schema.Struct({
  accountRef: PaymentProviderAccountRefSchema,
  environment: PaymentSourceEnvironmentSchema,
  sourceSystem: PaymentSourceSystemSchema,
});
export type PaymentCodCarrier = typeof PaymentCodCarrierSchema.Type;

/** Exact selected Delivery Offer, its confirmed carrier and its owner-issued COD capability evidence. */
export const PaymentCodDeliveryOfferBindingSchema = Schema.TaggedStruct('COD_DELIVERY_OFFER', {
  capabilityEvidenceRef: PaymentEvidenceRefSchema,
  carrier: PaymentCodCarrierSchema,
  deliveryOfferRef: PaymentDeliveryOfferRefSchema,
});

/** Exact selected pickup/on-site collection capability. */
export const PaymentPickupCapabilityBindingSchema = Schema.TaggedStruct('PICKUP_CAPABILITY', {
  capabilityEvidenceRef: PaymentEvidenceRefSchema,
  pickupCapabilityRef: PaymentPickupCapabilityRefSchema,
});

export const PaymentExecutionBindingSchema = Schema.Union([
  PaymentGatewayAccountBindingSchema,
  PaymentBankAccountingReceiptBindingSchema,
  PaymentCodDeliveryOfferBindingSchema,
  PaymentPickupCapabilityBindingSchema,
]);
export type PaymentExecutionBinding = typeof PaymentExecutionBindingSchema.Type;
