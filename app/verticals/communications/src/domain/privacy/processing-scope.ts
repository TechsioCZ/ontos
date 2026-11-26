import { Schema } from 'effect';

import { CommunicationResourceRefSchema, PrivacyPurposeKeySchema } from '../catalog/vocabulary.ts';
import { EndpointChannelSchema } from '../recipient/original-binding.ts';

/**
 * The exact Privacy Processing Scope of ONE message to ONE original recipient (#1396, BR-01): Subject x Controller x
 * Purpose Version x Processing Activity x material recipient, channel and data scope. A source producer declares it;
 * Communications never derives a Controller, a purpose or a legal basis, and never widens a scope. Privacy resolves
 * the Privacy Subject from the located source record or Party target, so no e-mail address, no Party matched by
 * address and no anonymous browser context can ever identify the subject here.
 */

const Ref = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(300));

/** Identifiers of the Privacy owner and of the source record, branded so none is interchangeable with another. */
export const PrivacyScopeIdSchema = Ref.pipe(Schema.brand('CommunicationsPrivacyScopeId'));
export const PrivacyPurposeVersionIdSchema = Ref.pipe(Schema.brand('CommunicationsPrivacyPurposeVersionId'));
const SourceOccurrenceRefSchema = Ref.pipe(Schema.brand('CommunicationsSourceOccurrenceRef'));
const SourceRecordRefSchema = Ref.pipe(Schema.brand('CommunicationsSourceRecordRef'));
export const PrivacySubjectResourceIdSchema = Ref.pipe(Schema.brand('CommunicationsPrivacySubjectResourceId'));
/** Privacy's own identity of a subject it bound before the address was verified; opaque to Communications. */
export const PrivacyBindingRefSchema = Ref.pipe(Schema.brand('CommunicationsPrivacyBindingRef'));

/**
 * How the subject is LOCATED, never who the subject is: an owner-qualified source record, the Party the source already
 * holds, or the subject Privacy itself bound for a source account whose address is not verified yet (#1406 D.8, a Portal
 * Auth issuance, for example). A locator is not proof of identity or of a right to process; Privacy alone decides whether
 * it names a supported context.
 */
export const SubjectLocatorSchema = Schema.Union([
  Schema.Struct({
    kind: Schema.Literal('SOURCE_ASSERTED'),
    source: Schema.Struct({
      issuer: Ref,
      namespace: Ref,
      occurrenceId: SourceOccurrenceRefSchema,
      recordId: SourceRecordRefSchema,
      recordType: Ref,
      routeRef: Ref,
    }),
  }),
  Schema.Struct({ kind: Schema.Literal('PARTY_TARGET'), partyRef: CommunicationResourceRefSchema }),
  Schema.Struct({ bindingRef: PrivacyBindingRefSchema, kind: Schema.Literal('PRIVACY_BINDING') }),
]);

export type SubjectLocator = typeof SubjectLocatorSchema.Type;

export const ProcessingScopeSchema = Schema.Struct({
  /** The catalog's reference to the Privacy purpose; it must be one the approved type declares. */
  catalogPurposeRef: PrivacyPurposeKeySchema,
  /** Material channel of the message, for example `email`; an ALLOWED for another channel is another scope. */
  channel: EndpointChannelSchema,
  controllerRef: Ref,
  dataCategoryRefs: Schema.Array(Ref).check(Schema.isMaxLength(64)),
  /** The Processing Activity. */
  operation: Ref,
  processingScopeRef: Schema.Struct({ scopeId: PrivacyScopeIdSchema, scopeType: Ref }),
  purposeRef: Ref,
  purposeVersionId: PrivacyPurposeVersionIdSchema,
  /** Material recipient dimension of the processing, as Privacy declares it; never empty. */
  recipientRefs: Schema.NonEmptyArray(Ref),
  subject: SubjectLocatorSchema,
});
export type ProcessingScope = typeof ProcessingScopeSchema.Type;

const sorted = (values: readonly string[]) => values.toSorted();

/**
 * Parts joined by their own length, so no value can imitate a boundary: `3:abc|1:d` has exactly one reading whatever
 * characters the parts contain. A key built from joined parts is never ambiguous.
 */
const lengthPrefixed = (parts: readonly string[]): string =>
  parts.map((part) => `${String(part.length)}:${part}`).join('|');

const subjectParts = (subject: SubjectLocator): readonly string[] => {
  if (subject.kind === 'PARTY_TARGET') {
    return [subject.kind, subject.partyRef.moduleId, subject.partyRef.resourceType, subject.partyRef.resourceId];
  }
  if (subject.kind === 'PRIVACY_BINDING') {
    return [subject.kind, subject.bindingRef];
  }
  // The source record fields are ordered by name, so the key never depends on how the record was assembled.
  return [
    subject.kind,
    ...Object.entries(subject.source)
      .toSorted(([a], [b]) => a.localeCompare(b))
      .flatMap(([key, value]) => [key, value]),
  ];
};

/** Equal exactly when two locators name the same source record or the same Party target. */
export const subjectLocatorKey = (subject: SubjectLocator): string => lengthPrefixed(subjectParts(subject));

/**
 * Stable identity of a scope: equal exactly when every dimension is, whatever the order of its lists. Nothing else
 * (a TTL, a clock, a previous result) is part of it, so no result can be reused for a scope that differs in any part.
 * Every part and every list is length-prefixed, so two different scopes can never produce the same key.
 */
export const processingScopeKey = (scope: ProcessingScope): string =>
  lengthPrefixed([
    subjectLocatorKey(scope.subject),
    scope.controllerRef,
    scope.purposeRef,
    scope.purposeVersionId,
    scope.catalogPurposeRef,
    scope.operation,
    scope.processingScopeRef.scopeType,
    scope.processingScopeRef.scopeId,
    scope.channel,
    lengthPrefixed(sorted(scope.dataCategoryRefs)),
    lengthPrefixed(sorted(scope.recipientRefs)),
  ]);
