// Canonical schema-only contract extracted from the generated change-retail-payment-term-preference Action.
import { Schema } from 'effect';
import { CustomerPaymentTermsStateSchema } from '../domain/payment-term-contracts.ts';
import {
  ClearCustomerPaymentTermPreferenceSchema,
  SetCustomerPaymentTermPreferenceSchema,
} from '../domain/payment-terms.ts';
import { RetailCustomerProfileRefSchema } from '../resources/retail-customer-profile.ts';

const RetailPaymentTermPreferenceChangeSchema = Schema.Union([
  SetCustomerPaymentTermPreferenceSchema,
  ClearCustomerPaymentTermPreferenceSchema,
]);
export type RetailPaymentTermPreferenceChange = typeof RetailPaymentTermPreferenceChangeSchema.Type;

export const ChangeRetailPaymentTermPreferencePayloadSchema = Schema.Struct({
  change: RetailPaymentTermPreferenceChangeSchema,
  expectedRevision: Schema.Finite.check(Schema.isInt(), Schema.isGreaterThanOrEqualTo(1)),
  profileRef: RetailCustomerProfileRefSchema,
});
export type ChangeRetailPaymentTermPreferencePayload = typeof ChangeRetailPaymentTermPreferencePayloadSchema.Type;

export const ChangeRetailPaymentTermPreferenceResultSchema = Schema.Struct({
  changed: Schema.Boolean,
  state: CustomerPaymentTermsStateSchema,
});
export type ChangeRetailPaymentTermPreferenceResult = typeof ChangeRetailPaymentTermPreferenceResultSchema.Type;
