import { Schema } from 'effect';

import {
  PaymentCustomerConfigurationIdSchema,
  PaymentReasonSchema,
  PaymentRevisionSchema,
} from '../domain/payment-identifiers.ts';
import { PaymentMethodSchema } from '../domain/payment-vocabulary.ts';

/**
 * Declarative merchant enablement of one Payment Method for one Customer Configuration in the trusted
 * Selling Legal Entity (#1147). Principal Permission to change it is the Action's access declaration;
 * the configuration itself never selects a method, gateway account or Delivery Offer for a customer.
 */
export const ConfigurePaymentMethodEnablementPayloadSchema = Schema.Struct({
  customerConfigurationId: PaymentCustomerConfigurationIdSchema,
  enabled: Schema.Boolean,
  /** The Current revision decided against; omit it only for the first configuration of the method. */
  expectedRevision: Schema.optionalKey(PaymentRevisionSchema),
  method: PaymentMethodSchema,
  reason: PaymentReasonSchema,
});
export type ConfigurePaymentMethodEnablementPayload = typeof ConfigurePaymentMethodEnablementPayloadSchema.Type;

export const ConfigurePaymentMethodEnablementResultSchema = Schema.Struct({
  /** False when the requested state was already Current: no revision was appended. */
  changed: Schema.Boolean,
  /** Actual time the Current state was configured; never backdated. */
  configuredAt: Schema.DateTimeUtcFromString,
  customerConfigurationId: PaymentCustomerConfigurationIdSchema,
  enabled: Schema.Boolean,
  method: PaymentMethodSchema,
  revision: PaymentRevisionSchema,
});
export type ConfigurePaymentMethodEnablementResult = typeof ConfigurePaymentMethodEnablementResultSchema.Type;
