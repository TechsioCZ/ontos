import { Schema } from 'effect';

import { PaymentPrincipalIdSchema } from '../domain/payment-identifiers.ts';
import {
  PaymentSourceAuthorityConfigurationResultSchema,
  PaymentSourceAuthorityConfigurationSchema,
} from '../domain/source-statement.ts';

/**
 * The principals allowed to submit statements as one source authority (#1152/#1153): its integration,
 * provider or POS/operator principals. Holding the observation or local-evidence permission is not
 * source authority; only a principal bound here speaks as the configured source.
 */
export const PaymentSourceSubmitterPrincipalIdsSchema = Schema.Array(PaymentPrincipalIdSchema).check(
  Schema.isMinLength(1),
  Schema.isMaxLength(100),
  Schema.isUnique(),
);

/**
 * Configures one exact source authority for one fact family (#1152 "Authority by fact family"): source
 * kind, system, account and environment, optionally one Payment Method, ACTIVE or REVOKED, whether it is
 * a refund execution route, and the exact principals bound to submit as it (#1153). Every change of the
 * binding is a new audited revision; there is no global precedence between sources.
 */
export const ConfigurePaymentSourceAuthorityPayloadSchema = Schema.Struct({
  ...PaymentSourceAuthorityConfigurationSchema.fields,
  submitterPrincipalIds: PaymentSourceSubmitterPrincipalIdsSchema,
});
export type ConfigurePaymentSourceAuthorityPayload = typeof ConfigurePaymentSourceAuthorityPayloadSchema.Type;

export const ConfigurePaymentSourceAuthorityResultSchema = Schema.Struct({
  ...PaymentSourceAuthorityConfigurationResultSchema.fields,
  submitterPrincipalIds: PaymentSourceSubmitterPrincipalIdsSchema,
});
export type ConfigurePaymentSourceAuthorityResult = typeof ConfigurePaymentSourceAuthorityResultSchema.Type;
