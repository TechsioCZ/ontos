// Canonical schema-only contract extracted from the generated remove-customer-payment-term Action.
import { Schema } from 'effect';
import { CounterpartyRefSchema } from '../domain/access-contract.ts';
import {
  CustomerPaymentTermsStateSchema,
  PaymentTermsTimestampSchema,
} from '../domain/payment-term-contracts.ts';
import { CustomerPaymentTermRemovalKindSchema } from '../domain/payment-terms.ts';
import { CounterpartyPurchasingProfileRefSchema } from '../resources/counterparty-purchasing-profile.ts';
import { CustomerPaymentTermEntitlementRefSchema } from '../resources/customer-payment-term-entitlement.ts';

export const RemoveCustomerPaymentTermPayloadSchema = Schema.Struct({
  counterpartyRef: CounterpartyRefSchema,
  effectiveAt: PaymentTermsTimestampSchema,
  entitlementRef: CustomerPaymentTermEntitlementRefSchema,
  expectedRevision: Schema.Finite.check(Schema.isInt(), Schema.isGreaterThanOrEqualTo(1)),
  profileRef: CounterpartyPurchasingProfileRefSchema,
  reason: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(500)),
});
export type RemoveCustomerPaymentTermPayload = typeof RemoveCustomerPaymentTermPayloadSchema.Type;

export const RemoveCustomerPaymentTermResultSchema = Schema.Struct({
  changed: Schema.Boolean,
  preferenceCleared: Schema.Boolean,
  removalKind: CustomerPaymentTermRemovalKindSchema,
  state: CustomerPaymentTermsStateSchema,
});
export type RemoveCustomerPaymentTermResult = typeof RemoveCustomerPaymentTermResultSchema.Type;
