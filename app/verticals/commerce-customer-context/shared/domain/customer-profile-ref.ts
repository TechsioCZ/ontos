import { Schema } from 'effect';
import { CounterpartyRefSchema } from '@app/party-registry/resources/counterparty';
import { CounterpartyPurchasingProfileRefSchema } from '../resources/counterparty-purchasing-profile.ts';
import { RetailCustomerProfileRefSchema } from '../resources/retail-customer-profile.ts';

/**
 * Stable profile identity shared by the Current purchase-context contracts.
 * Customer settings are deliberately not part of this module.
 */
export const CustomerProfileRefSchema = Schema.Union([
  RetailCustomerProfileRefSchema,
  CounterpartyPurchasingProfileRefSchema,
]);
export type CustomerProfileRef = typeof CustomerProfileRefSchema.Type;

/** Exact authorization subject accepted by a profile purchase-currency request. */
export const PurchaseCurrencyAuthorizationSubjectSchema = Schema.Union([
  Schema.Struct({ kind: Schema.Literal('RETAIL') }),
  Schema.Struct({
    counterpartyRef: CounterpartyRefSchema,
    kind: Schema.Literal('COUNTERPARTY'),
  }),
]);
export type PurchaseCurrencyAuthorizationSubject = typeof PurchaseCurrencyAuthorizationSubjectSchema.Type;

export const isPurchaseCurrencyAuthorizationSubjectCompatible = (
  profileRef: CustomerProfileRef,
  subject: PurchaseCurrencyAuthorizationSubject,
): boolean =>
  profileRef.tenantId === (subject.kind === 'COUNTERPARTY' ? subject.counterpartyRef.tenantId : profileRef.tenantId) &&
  ((profileRef.resourceType === 'commerce.customer-context.retail-customer-profile' && subject.kind === 'RETAIL') ||
    (profileRef.resourceType === 'commerce.customer-context.counterparty-purchasing-profile' &&
      subject.kind === 'COUNTERPARTY'));
