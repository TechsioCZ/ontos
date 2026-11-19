import { Schema } from 'effect';

import { CommunicationResourceRefSchema, PrivacyPurposeKeySchema, resourceRefKey } from '../catalog/vocabulary.ts';
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

/**
 * How the subject is LOCATED, never who the subject is: an owner-qualified source record (an Auth occurrence before the
 * address is verified, for example) or the Party the source already holds. A locator is not proof of identity or of
 * a right to process; Privacy alone decides whether it names a supported context.
 */
const SubjectLocatorSchema = Schema.Union([
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
]);

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

/** Control characters never occur in a closed reference, so these separators keep parts unambiguous. */
const PART = '\u0000';
const FIELD = '\u0001';
const sorted = (values: readonly string[]) => values.toSorted();

/**
 * Stable identity of a scope: equal exactly when every dimension is, whatever the order of its lists. Nothing else
 * (a TTL, a clock, a previous result) is part of it, so no result can be reused for a scope that differs in any part.
 */
export const processingScopeKey = (scope: ProcessingScope): string =>
  [
    scope.subject.kind === 'SOURCE_ASSERTED'
      ? [
          'SOURCE_ASSERTED',
          ...Object.entries(scope.subject.source)
            .toSorted(([a], [b]) => a.localeCompare(b))
            .map(([key, value]) => `${key}=${value}`),
        ].join(FIELD)
      : `PARTY_TARGET${FIELD}${resourceRefKey(scope.subject.partyRef)}`,
    scope.controllerRef,
    scope.purposeRef,
    scope.purposeVersionId,
    scope.catalogPurposeRef,
    scope.operation,
    scope.processingScopeRef.scopeType,
    scope.processingScopeRef.scopeId,
    scope.channel,
    sorted(scope.dataCategoryRefs).join(FIELD),
    sorted(scope.recipientRefs).join(FIELD),
  ].join(PART);
