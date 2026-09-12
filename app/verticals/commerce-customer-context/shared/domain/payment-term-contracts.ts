import { PaymentTermRefSchema } from '@app/payment-term-catalog-contracts/resources/payment-term';
import type { PaymentTermRef } from '@app/payment-term-catalog-contracts/resources/payment-term';
import { DateTime, Option, Schema, SchemaGetter } from 'effect';
import { CounterpartyPurchasingProfileRefSchema } from '../resources/counterparty-purchasing-profile.ts';
import { CustomerPaymentTermEntitlementRefSchema } from '../resources/customer-payment-term-entitlement.ts';
import { RetailCustomerProfileRefSchema } from '../resources/retail-customer-profile.ts';
import { CounterpartyRefSchema } from './access-contract.ts';

const boundedText = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(300));

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
    decode: SchemaGetter.dateTimeUtcFromInput<string>().map(DateTime.formatIso),
    encode: SchemaGetter.dateTimeUtcFromInput<string>().map(DateTime.formatIso),
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

const PaymentTermSemanticSchema = Schema.Union([
  Schema.Struct({
    calculationRuleVersion: Schema.Literal(1),
    calendarRule: Schema.Literal('NOT_APPLICABLE'),
    kind: Schema.Literal('IMMEDIATE'),
  }),
  Schema.Struct({
    calculationRuleVersion: Schema.Literal(1),
    calendarRule: Schema.Literal('CALENDAR_DAYS_UTC'),
    days: Schema.Finite.check(Schema.isInt(), Schema.isGreaterThanOrEqualTo(0)),
    dueDateAnchor: Schema.Literal('INVOICE_ISSUED_AT'),
    kind: Schema.Literal('NET_DAYS'),
  }),
]);

const paymentTermCompatibilityId = boundedText.pipe(
  Schema.brand('CustomerPaymentTermsCompatibilityId'),
  Schema.decodeTo(Schema.String),
);
const paymentTermRevisionId = Schema.String.check(Schema.isUUID()).pipe(
  Schema.brand('CustomerPaymentTermsRevisionId'),
  Schema.decodeTo(Schema.String),
);
const semanticFingerprint = Schema.String.check(Schema.isPattern(/^[0-9a-f]{64}$/u));

const PaymentTermDefinitionSnapshotFieldsSchema = Schema.Struct({
  code: boundedText,
  compatibilityId: paymentTermCompatibilityId,
  compatibleWith: Schema.Array(Schema.Literal('customer-payment-terms.v1')),
  definitionRevisionId: paymentTermRevisionId,
  lifecycle: Schema.Struct({
    effectiveFrom: PaymentTermsTimestampSchema,
    // The Payment-owned wire contract uses JSON null to mean no scheduled retirement.
    effectiveTo: Schema.Union([PaymentTermsTimestampSchema, Schema.Null]),
    state: Schema.Literals(['ACTIVE', 'RETIRED']),
  }),
  metadataRevision: Schema.Finite.check(Schema.isInt(), Schema.isGreaterThanOrEqualTo(1)),
  name: boundedText,
  paymentTermRef: PaymentTermReferenceSchema,
  semanticFingerprint,
  semanticRevisionId: paymentTermRevisionId,
  semantics: PaymentTermSemanticSchema,
});
export const PaymentTermDefinitionSnapshotSchema = PaymentTermDefinitionSnapshotFieldsSchema.check(
  Schema.makeFilter((definition) => {
    const lifecycleIsValid =
      (definition.lifecycle.state === 'ACTIVE' && definition.lifecycle.effectiveTo === null) ||
      (definition.lifecycle.state === 'RETIRED' && definition.lifecycle.effectiveTo !== null);
    if (!lifecycleIsValid) {
      return 'Payment Term lifecycle state and effective end must agree';
    }
    if (
      definition.lifecycle.effectiveTo !== null &&
      definition.lifecycle.effectiveTo < definition.lifecycle.effectiveFrom
    ) {
      return 'Payment Term retirement cannot precede activation';
    }
    return definition.compatibleWith.includes('customer-payment-terms.v1')
      ? undefined
      : 'Payment Term is not compatible with customer payment terms';
  }),
);
export type PaymentTermDefinitionSnapshot = typeof PaymentTermDefinitionSnapshotSchema.Type;

export const CustomerPaymentTermEntitlementSchema = Schema.Struct({
  cancelledAt: Schema.optionalKey(PaymentTermsTimestampSchema),
  effectiveFrom: PaymentTermsTimestampSchema,
  effectiveTo: Schema.optionalKey(PaymentTermsTimestampSchema),
  entitlementRef: CustomerPaymentTermEntitlementRefSchema,
  paymentTermRef: PaymentTermReferenceSchema,
  semanticRevisionId: paymentTermRevisionId,
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
