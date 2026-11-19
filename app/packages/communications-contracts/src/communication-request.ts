import { OntosModuleIdSchema } from '@app/core-runtime/modules/manifest';
import { LegalEntityRefSchema } from '@app/core-runtime/resources/legal-entity';
import { Schema } from 'effect';

/**
 * Public, schema-only Communication Request. A source MicroVertical commits it with its own business fact. It states
 * what happened and for whom, never what to send: no secret, no message content or template choice, no language,
 * no recipient address and no delivery result. Communications owns message selection, language, the original
 * endpoint, delivery and history; the source only names references.
 */

const opaqueText = Schema.String.check(
  Schema.isMinLength(1),
  Schema.isMaxLength(200),
  Schema.isPattern(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/u),
);

const lowerDottedText = Schema.String.check(
  Schema.isMinLength(1),
  Schema.isMaxLength(120),
  Schema.isPattern(/^[a-z][a-z0-9]*(?:-[a-z0-9]+)*(?:\.[a-z][a-z0-9]*(?:-[a-z0-9]+)*)*$/u),
);

const CommunicationTenantIdSchema = Schema.String.check(Schema.isUUID()).pipe(Schema.brand('CommunicationTenantId'));
const CommunicationOccurrenceIdSchema = opaqueText.pipe(Schema.brand('CommunicationOccurrenceId'));
const CommunicationResourceIdSchema = opaqueText.pipe(Schema.brand('CommunicationResourceId'));
const CommunicationResourceTypeSchema = lowerDottedText.pipe(Schema.brand('CommunicationResourceType'));
const CommunicationCorrelationIdSchema = opaqueText.pipe(Schema.brand('CommunicationCorrelationId'));
const CommunicationIdempotencyKeySchema = opaqueText.pipe(Schema.brand('CommunicationIdempotencyKey'));
const CommunicationSafeReferenceKeySchema = lowerDottedText.pipe(Schema.brand('CommunicationSafeReferenceKey'));
const CommunicationRecipientRoleSchema = lowerDottedText.pipe(Schema.brand('CommunicationRecipientRole'));
const CommunicationRevisionSchema = Schema.Int.check(
  Schema.isGreaterThanOrEqualTo(1),
  Schema.isLessThanOrEqualTo(2_147_483_647),
);

/** Exact source of the request: the business module whose committed fact caused it. */
export const CommunicationRequestSourceSchema = Schema.Struct({
  moduleKey: OntosModuleIdSchema,
});
export type CommunicationRequestSource = typeof CommunicationRequestSourceSchema.Type;

/** Stable key of the reason the source asks for a communication. Communications maps it to message types. */
export const CommunicationPurposeKeySchema = lowerDottedText.pipe(Schema.brand('CommunicationPurposeKey'));
export type CommunicationPurposeKey = typeof CommunicationPurposeKeySchema.Type;

/** The one committed source occurrence and the revision of it this request reflects. */
export const CommunicationSourceOccurrenceSchema = Schema.Struct({
  occurrenceId: CommunicationOccurrenceIdSchema,
  revision: CommunicationRevisionSchema,
});
export type CommunicationSourceOccurrence = typeof CommunicationSourceOccurrenceSchema.Type;

/** Structural reference to an owner resource; never a copy of the resource. */
export const CommunicationResourceRefSchema = Schema.Struct({
  moduleId: OntosModuleIdSchema,
  resourceId: CommunicationResourceIdSchema,
  resourceType: CommunicationResourceTypeSchema,
});
export type CommunicationResourceRef = typeof CommunicationResourceRefSchema.Type;

/**
 * Trusted scope the source operated in. Tenant is required; Legal Entity and the profile, Counterparty and
 * Storefront references are present only when the source fact has them.
 */
export const CommunicationRequestScopeSchema = Schema.Struct({
  counterpartyRef: Schema.optionalKey(CommunicationResourceRefSchema),
  legalEntityId: Schema.optionalKey(LegalEntityRefSchema.fields.resourceId),
  profileRef: Schema.optionalKey(CommunicationResourceRefSchema),
  storefrontRef: Schema.optionalKey(CommunicationResourceRefSchema),
  tenantId: CommunicationTenantIdSchema,
});
export type CommunicationRequestScope = typeof CommunicationRequestScopeSchema.Type;

/**
 * How the source owner evidences the contact that was valid at the original event. Only these three evidence kinds
 * exist, and each names a reference or a revision, never an address: the endpoint itself stays with its owner.
 * - HISTORICAL_SNAPSHOT: the owner keeps a snapshot of the contact taken at the event;
 * - VERSIONED_SNAPSHOT: the contact record is correctly versioned and `contactRevision` was the one valid then;
 * - AUTHORITATIVE_REFERENCE: a safe owner reference that keeps the same meaning ("the endpoint of the event").
 * A source that cannot evidence the original contact sends none (`originalContact` absent); Communications never
 * reconstructs it from a Current profile, so the recipient stays unresolved.
 */
export const OriginalContactEvidenceSchema = Schema.Union([
  Schema.Struct({ kind: Schema.Literal('HISTORICAL_SNAPSHOT'), snapshotRef: CommunicationResourceRefSchema }),
  Schema.Struct({ contactRevision: CommunicationRevisionSchema, kind: Schema.Literal('VERSIONED_SNAPSHOT') }),
  Schema.Struct({ kind: Schema.Literal('AUTHORITATIVE_REFERENCE') }),
]);
export type OriginalContactEvidence = typeof OriginalContactEvidenceSchema.Type;

/** The contact reference valid at the original event and the evidence that it was. Never an address. */
export const OriginalContactBindingSchema = Schema.Struct({
  contactRef: CommunicationResourceRefSchema,
  evidence: OriginalContactEvidenceSchema,
});
export type OriginalContactBinding = typeof OriginalContactBindingSchema.Type;

/**
 * One Message Recipient exactly as the source event fixed it: who (`recipientRef`), in which audience `role`, the
 * trusted `scope` the pair was evidenced in, the instant the source event fixed it and, when evidenced, the original
 * contact. It is neither a Privacy Recipient nor a Party, Principal or Customer Profile, and a later contact
 * correction never rewrites it: a different recipient needs a new source request with its own correlation.
 */
export const OriginalRecipientBindingSchema = Schema.Struct({
  originalContact: Schema.optionalKey(OriginalContactBindingSchema),
  recipientRef: CommunicationResourceRefSchema,
  role: CommunicationRecipientRoleSchema,
  scope: CommunicationRequestScopeSchema,
  validAt: Schema.DateTimeUtcFromString,
});
export type OriginalRecipientBinding = typeof OriginalRecipientBindingSchema.Type;

/** A named reference the message may link to or render from, resolved later through its owner. */
export const CommunicationSafeReferenceSchema = Schema.Struct({
  key: CommunicationSafeReferenceKeySchema,
  ref: CommunicationResourceRefSchema,
});
export type CommunicationSafeReference = typeof CommunicationSafeReferenceSchema.Type;

const MAX_SAFE_REFERENCES = 16;

const SafeReferencesSchema = Schema.Array(CommunicationSafeReferenceSchema).check(
  Schema.isMaxLength(MAX_SAFE_REFERENCES),
  Schema.makeFilter((references) =>
    new Set(references.map((reference) => reference.key)).size === references.length
      ? undefined
      : 'safe reference keys must be unique',
  ),
);

/** Source-owned replay identity: the same business occurrence and revision always carries the same key. */
export const CommunicationIdempotencySchema = Schema.Struct({
  correlationId: Schema.optionalKey(CommunicationCorrelationIdSchema),
  key: CommunicationIdempotencyKeySchema,
});
export type CommunicationIdempotency = typeof CommunicationIdempotencySchema.Type;

export const CommunicationRequestSchema = Schema.Struct({
  idempotency: CommunicationIdempotencySchema,
  occurrence: CommunicationSourceOccurrenceSchema,
  originalRecipients: Schema.NonEmptyArray(OriginalRecipientBindingSchema),
  purpose: CommunicationPurposeKeySchema,
  safeReferences: SafeReferencesSchema,
  schemaVersion: Schema.Literal(1),
  scope: CommunicationRequestScopeSchema,
  source: CommunicationRequestSourceSchema,
});
export type CommunicationRequest = typeof CommunicationRequestSchema.Type;
export type CommunicationRequestEncoded = typeof CommunicationRequestSchema.Encoded;
