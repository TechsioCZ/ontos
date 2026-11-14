import { PrivacyIsoTimestampSchema } from '@app/consent-authority-contracts';
import { PrincipalRefSchema } from '@app/core-runtime/permissions/principal-ref';
import { DateTime, Option, Schema } from 'effect';

import { PrivacySubjectRefSchema } from '../resources/privacy-subject.ts';
import { PrivacyPartyRefSchema } from './party-reference.ts';

export { PrivacyIsoTimestampSchema } from '@app/consent-authority-contracts';

const NonEmptyText = Schema.Trim.check(Schema.isMinLength(1), Schema.isMaxLength(500));

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

/** Qualified source subject locator before Party identity exists. It supplies no identity proof,
 * processing permission, legal basis or independently verified statement about the subject. */
export const PrivacySourceRecordIdentitySchema = Schema.Struct({
  issuer: NonEmptyText,
  namespace: NonEmptyText,
  recordId: NonEmptyText.pipe(Schema.brand('PrivacySourceSubjectRecordId'), Schema.decodeTo(Schema.String)),
  recordType: NonEmptyText,
  routeRef: NonEmptyText,
});
export type PrivacySourceRecordIdentity = typeof PrivacySourceRecordIdentitySchema.Type;

/** Canonical length-prefixed key for the ordered tuple; punctuation inside an ID cannot collide. */
export const privacySourceSubjectIdentityKey = (source: PrivacySourceRecordIdentity): string =>
  [source.issuer, source.namespace, source.recordType, source.routeRef, source.recordId]
    .map((value) => `${value.length}:${value}`)
    .join('|');

/** A locator for a real source admission attempt; the Party owner must validate its committed receipt. */
export const PrivacySourceSubjectAdmissionSchema = Schema.Struct({
  occurrenceId: NonEmptyText.pipe(Schema.brand('PrivacySourceAdmissionOccurrenceId'), Schema.decodeTo(Schema.String)),
  sourceSubjectRef: PrivacySubjectRefSchema,
});
export type PrivacySourceSubjectAdmission = typeof PrivacySourceSubjectAdmissionSchema.Type;

export const PrivacySourcePersonReferenceSchema = Schema.Struct({
  occurrenceId: PrivacySourceSubjectAdmissionSchema.fields.occurrenceId,
  recordId: PrivacySourceRecordIdentitySchema.fields.recordId,
  source: Schema.Struct({
    issuer: PrivacySourceRecordIdentitySchema.fields.issuer,
    namespace: PrivacySourceRecordIdentitySchema.fields.namespace,
    recordType: PrivacySourceRecordIdentitySchema.fields.recordType,
    routeRef: PrivacySourceRecordIdentitySchema.fields.routeRef,
  }),
});
export type PrivacySourcePersonReference = typeof PrivacySourcePersonReferenceSchema.Type;

export const DataSubjectSchema = Schema.Struct({
  kind: Schema.Literal('DATA_SUBJECT'),
  partyRef: PrivacyPartyRefSchema,
  sourceAdmission: Schema.optionalKey(PrivacySourceSubjectAdmissionSchema),
});

export const PrivacySubjectSchema = Schema.Union([
  Schema.Struct({ kind: Schema.Literal('SOURCE_ASSERTED'), source: PrivacySourceRecordIdentitySchema }),
  DataSubjectSchema,
  Schema.Struct({ anonymousContext: AnonymousPrivacyContextSchema, kind: Schema.Literal('ANONYMOUS') }),
]);
export type PrivacySubject = typeof PrivacySubjectSchema.Type;

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
  authMethod: Schema.Literals(['session', 'api_key', 'oauth_connection', 'system', 'support_impersonation']),
  impersonatedBy: Schema.toEncoded(Schema.OptionFromNullOr(PrincipalRefSchema)),
});
export type PrincipalAttribution = typeof PrincipalAttributionSchema.Type;

/** Admission observation from an authorized Party owner Read; never permanent Current proof. */
export const PrivacySubjectOwnerEvidenceSchema = Schema.Struct({
  observedAt: PrivacyIsoTimestampSchema,
  ownerRevision: Schema.Number.check(Schema.isInt(), Schema.isGreaterThan(0)),
  partyRef: PrivacyPartyRefSchema,
  sourcePersonAdmission: Schema.optionalKey(
    Schema.Struct({
      sourceActionInvocationId: Schema.String.check(Schema.isUUID()).pipe(
        Schema.brand('PrivacyPartySourceActionInvocationId'),
        Schema.decodeTo(Schema.String),
      ),
      sourceDecisionRef: Schema.Struct({
        moduleId: Schema.Literal('party.registry'),
        resourceId: NonEmptyText.pipe(Schema.brand('PrivacyPartySourceDecisionId'), Schema.decodeTo(Schema.String)),
        resourceType: Schema.Literal('party.registry.party-match-decision'),
        tenantId: Schema.String.check(Schema.isUUID()).pipe(
          Schema.brand('PrivacyPartySourceDecisionTenantId'),
          Schema.decodeTo(Schema.String),
        ),
      }),
    }),
  ),
  typeAssertions: Schema.Array(
    Schema.Struct({
      assertionId: NonEmptyText.pipe(Schema.brand('PartyOwnerAssertionId')),
      validFrom: PrivacyIsoTimestampSchema,
      validTo: Schema.toEncoded(Schema.OptionFromNullOr(PrivacyIsoTimestampSchema)),
    }),
  ),
}).check(
  Schema.makeFilter((evidence) =>
    evidence.typeAssertions.length > 0 || evidence.sourcePersonAdmission !== undefined
      ? undefined
      : 'Current Party subject evidence requires actual type assertions or a real source-person admission receipt',
  ),
);
export type PrivacySubjectOwnerEvidence = typeof PrivacySubjectOwnerEvidenceSchema.Type;

export const PrivacySubjectRecordSchema = Schema.Struct({
  createdAt: PrivacyIsoTimestampSchema,
  ownerAdmission: Schema.optionalKey(PrivacySubjectOwnerEvidenceSchema),
  subject: PrivacySubjectSchema,
  subjectRef: PrivacySubjectRefSchema,
  updatedAt: PrivacyIsoTimestampSchema,
}).check(
  Schema.makeFilter((record) =>
    record.ownerAdmission === undefined ||
    (record.subject.kind === 'DATA_SUBJECT' &&
      Schema.toEquivalence(PrivacyPartyRefSchema)(record.subject.partyRef, record.ownerAdmission.partyRef))
      ? undefined
      : 'Owner admission evidence must identify this exact Data Subject Party',
  ),
);
export type PrivacySubjectRecord = typeof PrivacySubjectRecordSchema.Type;
