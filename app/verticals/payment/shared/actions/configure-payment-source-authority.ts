import {
  PaymentSourceAuthorityConfigurationResultSchema,
  PaymentSourceAuthorityConfigurationSchema,
} from '../domain/source-statement.ts';

/**
 * Configures one exact source authority for one fact family (#1152 "Authority by fact family"): source
 * kind, system, account and environment, optionally one Payment Method, ACTIVE or REVOKED, and whether
 * it is a refund execution route. There is no global precedence between sources.
 */
export const ConfigurePaymentSourceAuthorityPayloadSchema = PaymentSourceAuthorityConfigurationSchema;
export type ConfigurePaymentSourceAuthorityPayload = typeof ConfigurePaymentSourceAuthorityPayloadSchema.Type;

export const ConfigurePaymentSourceAuthorityResultSchema = PaymentSourceAuthorityConfigurationResultSchema;
export type ConfigurePaymentSourceAuthorityResult = typeof ConfigurePaymentSourceAuthorityResultSchema.Type;
