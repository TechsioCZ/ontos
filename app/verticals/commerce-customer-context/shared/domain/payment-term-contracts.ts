import { PaymentTermDefinitionSnapshotSchema } from '@app/payment-term-catalog-contracts/payment-term';
import { PaymentTermRefSchema } from '@app/payment-term-catalog-contracts/resources/payment-term';
import type { PaymentTermRef } from '@app/payment-term-catalog-contracts/resources/payment-term';
import { DateTime, Option, Schema, SchemaGetter } from 'effect';
import { CounterpartyPurchasingProfileRefSchema } from '../resources/counterparty-purchasing-profile.ts';
import { CustomerPaymentTermEntitlementRefSchema } from '../resources/customer-payment-term-entitlement.ts';
import { RetailCustomerProfileRefSchema } from '../resources/retail-customer-profile.ts';
import { CounterpartyRefSchema } from './access-contract.ts';

export const PaymentTermsTimestampSchema = Schema.String.check(
  Schema.isPattern(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u),
  Schema.makeFilter((value) => {
    const parsed = DateTime.make(value);
    return Option.isSome(parsed) && DateTime.formatIso(parsed.value) === value
      ? undefined
      : 'invalid canonical UTC timestamp';
  }),
).pipe(
  Schema.decode({
    decode: SchemaGetter.dateTimeUtcFromInput<string>().pipe(SchemaGetter.map(DateTime.formatIso)),
    encode: SchemaGetter.dateTimeUtcFromInput<string>().pipe(SchemaGetter.map(DateTime.formatIso)),
  }),
);

export const PaymentTermReferenceSchema = PaymentTermRefSchema;
export type PaymentTermReference = PaymentTermRef;

export const CommerceCustomerProfileRefSchema = Schema.Union([
  RetailCustomerProfileRefSchema,
  CounterpartyPurchasingProfileRefSchema,
]);
export type CommerceCustomerProfileRef = typeof CommerceCustomerProfileRefSchema.Type;

export const PaymentTermsAuthorizationSubjectSchema = Schema.Union([
  Schema.Struct({ kind: Schema.Literal('RETAIL') }),
  Schema.Struct({
    counterpartyRef: CounterpartyRefSchema,
    kind: Schema.Literal('COUNTERPARTY'),
  }),
]);
export type PaymentTermsAuthorizationSubject = typeof PaymentTermsAuthorizationSubjectSchema.Type;

export const isPaymentTermsAuthorizationSubjectCompatible = (
  profileRef: CommerceCustomerProfileRef,
  subject: PaymentTermsAuthorizationSubject,
): boolean =>
  profileRef.tenantId === (subject.kind === 'COUNTERPARTY' ? subject.counterpartyRef.tenantId : profileRef.tenantId) &&
  ((profileRef.resourceType === 'commerce.customer-context.retail-customer-profile' && subject.kind === 'RETAIL') ||
    (profileRef.resourceType === 'commerce.customer-context.counterparty-purchasing-profile' &&
      subject.kind === 'COUNTERPARTY'));

export { PaymentTermDefinitionSnapshotSchema } from '@app/payment-term-catalog-contracts/payment-term';
export type PaymentTermDefinitionSnapshot = typeof PaymentTermDefinitionSnapshotSchema.Type;

/** Supported Current semantics; legacy snapshots remain decodable for retained history. */
export const isPaymentTermDefinitionSupported = (definition: PaymentTermDefinitionSnapshot): boolean =>
  definition.semantics.calculationRuleVersion === 2;

export const CustomerPaymentTermEntitlementSchema = Schema.Struct({
  cancelledAt: Schema.optionalKey(PaymentTermsTimestampSchema),
  effectiveFrom: PaymentTermsTimestampSchema,
  effectiveTo: Schema.optionalKey(PaymentTermsTimestampSchema),
  entitlementRef: CustomerPaymentTermEntitlementRefSchema,
  paymentTermRef: PaymentTermReferenceSchema,
  semanticRevisionId: PaymentTermDefinitionSnapshotSchema.fields.semanticRevisionId,
  status: Schema.Literals(['ACTIVE', 'CANCELLED']),
});
export type CustomerPaymentTermEntitlement = typeof CustomerPaymentTermEntitlementSchema.Type;

export const CustomerPaymentTermPreferenceSchema = Schema.Struct({
  effectiveFrom: PaymentTermsTimestampSchema,
  effectiveTo: Schema.optionalKey(PaymentTermsTimestampSchema),
  paymentTermRef: PaymentTermReferenceSchema,
});
export type CustomerPaymentTermPreference = typeof CustomerPaymentTermPreferenceSchema.Type;

export const CustomerPaymentTermsStateSchema = Schema.Struct({
  entitlements: Schema.Array(CustomerPaymentTermEntitlementSchema),
  preferences: Schema.Array(CustomerPaymentTermPreferenceSchema),
  profileRef: CommerceCustomerProfileRefSchema,
  revision: Schema.Finite.check(Schema.isInt(), Schema.isGreaterThanOrEqualTo(1)),
});
export type CustomerPaymentTermsState = typeof CustomerPaymentTermsStateSchema.Type;
