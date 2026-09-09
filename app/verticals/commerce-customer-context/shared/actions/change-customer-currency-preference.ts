// Canonical schema-only contract extracted from the generated change-customer-currency-preference Action.
import {
  ChangeCustomerCurrencyPreferenceCommandSchema,
  CustomerCurrencyPreferenceChangeResultSchema,
} from '../domain/customer-currency-preference.ts';

export const ChangeCustomerCurrencyPreferencePayloadSchema =
  ChangeCustomerCurrencyPreferenceCommandSchema;
export type ChangeCustomerCurrencyPreferencePayload =
  typeof ChangeCustomerCurrencyPreferencePayloadSchema.Type;

export const ChangeCustomerCurrencyPreferenceResultSchema =
  CustomerCurrencyPreferenceChangeResultSchema;
export type ChangeCustomerCurrencyPreferenceResult =
  typeof ChangeCustomerCurrencyPreferenceResultSchema.Type;
