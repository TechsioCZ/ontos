// Canonical schema-only contract extracted from the generated change-customer-payment-terms Action.
import { Schema } from 'effect';
import { CounterpartyRefSchema } from '../domain/access-contract.ts';
import { CustomerPaymentTermsStateSchema } from '../domain/payment-term-contracts.ts';
import { CustomerPaymentTermsChangeSchema } from '../domain/payment-terms.ts';
import { CounterpartyPurchasingProfileRefSchema } from '../resources/counterparty-purchasing-profile.ts';

const revision = Schema.Finite.check(Schema.isInt(), Schema.isGreaterThanOrEqualTo(1));
const reason = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(500));

export const ChangeCustomerPaymentTermsPayloadSchema = Schema.Struct({
  changes: Schema.Array(CustomerPaymentTermsChangeSchema).check(Schema.isMinLength(1), Schema.isMaxLength(50)),
  counterpartyRef: CounterpartyRefSchema,
  expectedRevision: revision,
  profileRef: CounterpartyPurchasingProfileRefSchema,
  reason,
});
export type ChangeCustomerPaymentTermsPayload = typeof ChangeCustomerPaymentTermsPayloadSchema.Type;

export const ChangeCustomerPaymentTermsResultSchema = Schema.Struct({
  changed: Schema.Boolean,
  state: CustomerPaymentTermsStateSchema,
});
export type ChangeCustomerPaymentTermsResult = typeof ChangeCustomerPaymentTermsResultSchema.Type;
