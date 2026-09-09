import { Schema } from 'effect';
import { CounterpartyRefSchema } from '@app/party-registry/resources/counterparty';
import { CounterpartyPurchasingProfileRefSchema } from '../resources/counterparty-purchasing-profile.ts';
import { CustomerCurrencyPreferenceRefSchema } from '../resources/customer-currency-preference.ts';
import { RetailCustomerProfileRefSchema } from '../resources/retail-customer-profile.ts';
import { CurrencyCodeSchema } from './currency.ts';
import type { CurrencyCode } from './currency.ts';
import { ProfileInstantSchema } from './profile-contracts.ts';

export const CustomerProfileRefSchema = Schema.Union([
  RetailCustomerProfileRefSchema,
  CounterpartyPurchasingProfileRefSchema,
]);
export type CustomerProfileRef = typeof CustomerProfileRefSchema.Type;

export const CustomerCurrencyAuthorizationSubjectSchema = Schema.Union([
  Schema.Struct({ kind: Schema.Literal('RETAIL') }),
  Schema.Struct({
    counterpartyRef: CounterpartyRefSchema,
    kind: Schema.Literal('COUNTERPARTY'),
  }),
]);
export type CustomerCurrencyAuthorizationSubject =
  typeof CustomerCurrencyAuthorizationSubjectSchema.Type;

export const isCustomerCurrencyAuthorizationSubjectCompatible = (
  profileRef: CustomerProfileRef,
  subject: CustomerCurrencyAuthorizationSubject,
): boolean =>
  profileRef.tenantId ===
    (subject.kind === 'COUNTERPARTY' ? subject.counterpartyRef.tenantId : profileRef.tenantId) &&
  ((profileRef.resourceType === 'commerce.customer-context.retail-customer-profile' &&
    subject.kind === 'RETAIL') ||
    (profileRef.resourceType === 'commerce.customer-context.counterparty-purchasing-profile' &&
      subject.kind === 'COUNTERPARTY'));

const RevisionSchema = Schema.Finite.check(Schema.isInt(), Schema.isGreaterThanOrEqualTo(0));
const PositiveRevisionSchema = Schema.Finite.check(Schema.isInt(), Schema.isGreaterThan(0));
export const CustomerCurrencyPreferenceSchema = Schema.Struct({
  createdAt: ProfileInstantSchema,
  currencyCode: CurrencyCodeSchema,
  preferenceRef: CustomerCurrencyPreferenceRefSchema,
  profileRef: CustomerProfileRefSchema,
  revision: PositiveRevisionSchema,
  updatedAt: ProfileInstantSchema,
});
export type CustomerCurrencyPreference = typeof CustomerCurrencyPreferenceSchema.Type;

export const CustomerCurrencyPreferenceSnapshotSchema = Schema.Union([
  Schema.Struct({
    profileRef: CustomerProfileRefSchema,
    revision: RevisionSchema,
    state: Schema.Literal('ABSENT'),
  }),
  Schema.Struct({
    preference: CustomerCurrencyPreferenceSchema,
    profileRef: CustomerProfileRefSchema,
    revision: PositiveRevisionSchema,
    state: Schema.Literal('PRESENT'),
  }),
]);
export type CustomerCurrencyPreferenceSnapshot =
  typeof CustomerCurrencyPreferenceSnapshotSchema.Type;

export const CustomerCurrencyPreferenceChangeSchema = Schema.Union([
  Schema.Struct({ currencyCode: CurrencyCodeSchema, kind: Schema.Literal('SET') }),
  Schema.Struct({ kind: Schema.Literal('CLEAR') }),
]);
export type CustomerCurrencyPreferenceChange = typeof CustomerCurrencyPreferenceChangeSchema.Type;

export const ChangeCustomerCurrencyPreferenceCommandSchema = Schema.Struct({
  authorizationSubject: CustomerCurrencyAuthorizationSubjectSchema,
  change: CustomerCurrencyPreferenceChangeSchema,
  expectedRevision: RevisionSchema,
  profileRef: CustomerProfileRefSchema,
}).check(
  Schema.makeFilter(({ authorizationSubject, profileRef }) =>
    isCustomerCurrencyAuthorizationSubjectCompatible(profileRef, authorizationSubject)
      ? undefined
      : 'The authorization subject must identify the exact kind and Tenant of the target profile',
  ),
);
export type ChangeCustomerCurrencyPreferenceCommand =
  typeof ChangeCustomerCurrencyPreferenceCommandSchema.Type;

export const CustomerCurrencyPreferenceChangeResultSchema = Schema.Struct({
  changed: Schema.Boolean,
  current: CustomerCurrencyPreferenceSnapshotSchema,
  previousCurrencyCode: Schema.Union([CurrencyCodeSchema, Schema.Null]),
});
export type CustomerCurrencyPreferenceChangeResult =
  typeof CustomerCurrencyPreferenceChangeResultSchema.Type;

export const CustomerCurrencyCodeUnrecognized = Schema.TaggedStruct(
  'CustomerCurrencyCodeUnrecognized',
  {
    code: Schema.Literal('customer_currency_code_unrecognized'),
    currencyCode: CurrencyCodeSchema,
    reason: Schema.String,
  },
);
export type CustomerCurrencyCodeUnrecognizedError = typeof CustomerCurrencyCodeUnrecognized.Type;

export const CustomerCurrencyPreferenceConflict = Schema.TaggedStruct(
  'CustomerCurrencyPreferenceConflict',
  {
    code: Schema.Literal('customer_currency_preference_conflict'),
    currentRevision: RevisionSchema,
    expectedRevision: RevisionSchema,
    reason: Schema.String,
  },
);
export type CustomerCurrencyPreferenceConflictError =
  typeof CustomerCurrencyPreferenceConflict.Type;

export const CustomerCurrencyPreferencePersistenceUnavailable = Schema.TaggedStruct(
  'CustomerCurrencyPreferencePersistenceUnavailable',
  {
    code: Schema.Literal('customer_currency_preference_persistence_unavailable'),
    reason: Schema.String,
  },
);
export type CustomerCurrencyPreferencePersistenceUnavailableError =
  typeof CustomerCurrencyPreferencePersistenceUnavailable.Type;

export const ChangeCustomerCurrencyPreferenceErrorSchema = Schema.Union([
  CustomerCurrencyCodeUnrecognized,
  CustomerCurrencyPreferenceConflict,
  CustomerCurrencyPreferencePersistenceUnavailable,
]);
export type ChangeCustomerCurrencyPreferenceError =
  typeof ChangeCustomerCurrencyPreferenceErrorSchema.Type;

const sameProfile = (left: CustomerProfileRef, right: CustomerProfileRef): boolean =>
  left.moduleId === right.moduleId &&
  left.resourceId === right.resourceId &&
  left.resourceType === right.resourceType &&
  left.tenantId === right.tenantId;

export const decideCustomerCurrencyPreferenceChange = (input: {
  readonly command: ChangeCustomerCurrencyPreferenceCommand;
  readonly current: CustomerCurrencyPreferenceSnapshot;
  readonly nextPreference?: CustomerCurrencyPreference;
  readonly recognizedCurrencies: readonly CurrencyCode[];
}): CustomerCurrencyPreferenceChangeResult | ChangeCustomerCurrencyPreferenceError => {
  const { change, expectedRevision, profileRef } = input.command;
  if (
    !sameProfile(profileRef, input.current.profileRef) ||
    (input.current.state === 'PRESENT' &&
      (!sameProfile(input.current.profileRef, input.current.preference.profileRef) ||
        input.current.revision !== input.current.preference.revision))
  ) {
    return CustomerCurrencyPreferenceConflict.make({
      code: 'customer_currency_preference_conflict',
      currentRevision: input.current.revision,
      expectedRevision,
      reason: 'The Current preference belongs to another Commerce Customer Profile',
    });
  }

  const previousCurrencyCode =
    input.current.state === 'PRESENT' ? input.current.preference.currencyCode : null;
  const equivalent =
    change.kind === 'CLEAR'
      ? input.current.state === 'ABSENT'
      : previousCurrencyCode === change.currencyCode;
  if (equivalent) {
    return { changed: false, current: input.current, previousCurrencyCode };
  }
  if (input.current.revision !== expectedRevision) {
    return CustomerCurrencyPreferenceConflict.make({
      code: 'customer_currency_preference_conflict',
      currentRevision: input.current.revision,
      expectedRevision,
      reason: 'The Customer Currency Preference changed after it was read',
    });
  }
  if (change.kind === 'SET' && !input.recognizedCurrencies.includes(change.currencyCode)) {
    return CustomerCurrencyCodeUnrecognized.make({
      code: 'customer_currency_code_unrecognized',
      currencyCode: change.currencyCode,
      reason: 'The requested currency is not in the Current recognized-currency catalog',
    });
  }
  if (change.kind === 'CLEAR') {
    return {
      changed: true,
      current: { profileRef, revision: input.current.revision + 1, state: 'ABSENT' },
      previousCurrencyCode,
    };
  }
  if (
    input.nextPreference === undefined ||
    !sameProfile(profileRef, input.nextPreference.profileRef) ||
    input.nextPreference.currencyCode !== change.currencyCode ||
    input.nextPreference.revision !== input.current.revision + 1
  ) {
    return CustomerCurrencyPreferencePersistenceUnavailable.make({
      code: 'customer_currency_preference_persistence_unavailable',
      reason:
        'The persisted Customer Currency Preference result did not match the requested value, profile, or next revision',
    });
  }
  return {
    changed: true,
    current: {
      preference: input.nextPreference,
      profileRef,
      revision: input.nextPreference.revision,
      state: 'PRESENT',
    },
    previousCurrencyCode,
  };
};
