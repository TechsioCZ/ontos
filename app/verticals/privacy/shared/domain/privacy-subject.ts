/* eslint-disable effect-native/no-string-timestamp-schema -- Privacy protocols expose canonical UTC `Z` timestamps on JSON wires; this shared codec rejects offsets and malformed values before domain ordering. expires: 2027-03-31. */
import { PrincipalRefSchema } from '@app/core-runtime';
import { DateTime, Option, Schema } from 'effect';

import { PrivacySubjectRefSchema } from '../resources/privacy-subject.ts';
import { PrivacyPartyRefSchema } from './party-reference.ts';

const NonEmptyText = Schema.Trim.check(Schema.isMinLength(1), Schema.isMaxLength(500));
export const PrivacyIsoTimestampSchema = Schema.String.check(
  Schema.isPattern(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/u),
);

const privacyTimestampMillis = (value: string): number | undefined =>
  DateTime.make(value).pipe(Option.map(DateTime.toEpochMillis), Option.getOrUndefined);

/** Compares timestamp strings by parsed instants; invalid values never authorize ordering. */
export const comparePrivacyInstants = (left: string, right: string): number | undefined => {
  const leftMillis = privacyTimestampMillis(left);
  const rightMillis = privacyTimestampMillis(right);
  return leftMillis === undefined || rightMillis === undefined ? undefined : leftMillis - rightMillis;
};

export const arePrivacyInstantsEqual = (left: string, right: string): boolean =>
  comparePrivacyInstants(left, right) === 0;

export const isPrivacyInstantAfter = (candidate: string, boundary: string): boolean =>
  (comparePrivacyInstants(candidate, boundary) ?? Number.NaN) > 0;

export const isPrivacyInstantAtOrBefore = (candidate: string, boundary: string): boolean =>
  (comparePrivacyInstants(candidate, boundary) ?? Number.NaN) <= 0;

export const isPrivacyInstantBefore = (candidate: string, boundary: string): boolean =>
  (comparePrivacyInstants(candidate, boundary) ?? Number.NaN) < 0;

export const AnonymousPrivacyContextSchema = Schema.Struct({
  addressability: Schema.Literals(['COOKIE', 'SESSION', 'DEVICE_BOUND']),
  contextRef: NonEmptyText,
  createdAt: PrivacyIsoTimestampSchema,
  expiresAt: PrivacyIsoTimestampSchema,
  kind: Schema.Literal('ANONYMOUS_PRIVACY_CONTEXT'),
  provenance: Schema.Struct({
    method: NonEmptyText,
    source: NonEmptyText,
  }),
});

export const PrivacySubjectSchema = Schema.Union([
  Schema.Struct({ kind: Schema.Literal('DATA_SUBJECT'), partyRef: PrivacyPartyRefSchema }),
  Schema.Struct({ anonymousContext: AnonymousPrivacyContextSchema, kind: Schema.Literal('ANONYMOUS') }),
]);
export type PrivacySubject = typeof PrivacySubjectSchema.Type;

export const DataSubjectSchema = Schema.Struct({
  kind: Schema.Literal('DATA_SUBJECT'),
  partyRef: PrivacyPartyRefSchema,
});

export const RequesterSchema = Schema.Struct({
  kind: Schema.Literals(['PRINCIPAL', 'ANONYMOUS']),
  principalRef: Schema.optionalKey(PrincipalRefSchema),
});

const RepresentationScopeSchema = Schema.Struct({
  operation: NonEmptyText,
  rights: Schema.Array(NonEmptyText).check(Schema.isMinLength(1), Schema.isMaxLength(32)),
  subjectRef: PrivacySubjectRefSchema,
});

export const RepresentationSchema = Schema.Struct({
  evidenceRefs: Schema.Array(NonEmptyText).check(Schema.isMinLength(1), Schema.isMaxLength(32)),
  representativePrincipal: PrincipalRefSchema,
  scope: RepresentationScopeSchema,
  validFrom: PrivacyIsoTimestampSchema,
  validTo: Schema.OptionFromNullOr(PrivacyIsoTimestampSchema),
});
export type Representation = typeof RepresentationSchema.Type;

export const PrincipalAttributionSchema = Schema.Struct({
  actor: PrincipalRefSchema,
  attributedAt: PrivacyIsoTimestampSchema,
  authMethod: Schema.Literals(['session', 'api_key', 'system', 'support_impersonation']),
  impersonatedBy: Schema.toEncoded(Schema.OptionFromNullOr(PrincipalRefSchema)),
});
export type PrincipalAttribution = typeof PrincipalAttributionSchema.Type;

export const PrivacySubjectRecordSchema = Schema.Struct({
  createdAt: PrivacyIsoTimestampSchema,
  subject: PrivacySubjectSchema,
  subjectRef: PrivacySubjectRefSchema,
  updatedAt: PrivacyIsoTimestampSchema,
});
export type PrivacySubjectRecord = typeof PrivacySubjectRecordSchema.Type;
