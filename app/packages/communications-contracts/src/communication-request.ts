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

/**
 * The one committed source occurrence and the revision of it this request reflects. `validUntil` is optional and
 * forward-compatible: when the source's own business fact expires (an issued link or code), the source states the instant
 * its occurrence stops being actionable, exactly as its owner stored it. Communications never extends it and stops a
 * handoff past it; a source without an expiry omits it, and a request that omits it means what it always meant.
 */
export const CommunicationSourceOccurrenceSchema = Schema.Struct({
  occurrenceId: CommunicationOccurrenceIdSchema,
  revision: CommunicationRevisionSchema,
  validUntil: Schema.optionalKey(Schema.DateTimeUtcFromString),
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

/**
 * The closed business reasons a source owner can give for an Explicit Resend. Communications records the reason with the
 * link between the new Message Intent and the original; it never accepts free text, so no address, secret or message
 * content can travel in it. A reason names why the source owner decided to communicate AGAIN: it grants nothing by itself.
 */
export const CommunicationResendReasonSchema = Schema.Literals([
  'PRIOR_DELIVERY_FAILED',
  'RECIPIENT_NOT_RECEIVED',
  'RECIPIENT_REQUESTED_COPY',
  'SOURCE_APPROVED_RESEND',
]);
export type CommunicationResendReason = typeof CommunicationResendReasonSchema.Type;

/**
 * Marks a request as an Explicit Resend (#1403): a NEW source occurrence, decided by the source owner after its own
 * business decision, that deliberately communicates again. It names the ORIGINAL Message Intent (as Communications
 * returned it to the same source) and why. It is only honoured for a message type whose platform catalog entry approves
 * resend; a request without it can never become a resend, and a resend never rewrites or reuses the original intent.
 */
export const CommunicationResendOfSchema = Schema.Struct({
  originalIntentId: Schema.String.check(Schema.isUUID()).pipe(Schema.brand('CommunicationOriginalIntentId')),
  reason: CommunicationResendReasonSchema,
});
export type CommunicationResendOf = typeof CommunicationResendOfSchema.Type;

/**
 * The form a document travels in: a LINK to the exact Media Asset (the default; its owner authorizes every open) or an
 * ATTACHMENT (an irreversible disclosure, honoured only for a message type whose owner approved it explicitly).
 */
export const CommunicationDocumentFormSchema = Schema.Literals(['ATTACHMENT', 'LINK']);
export type CommunicationDocumentForm = typeof CommunicationDocumentFormSchema.Type;

/**
 * The recipient scope the source asks the document to go to. Only `ORIGINAL_RECIPIENT` can ever be approved by a type; asking
 * another one is stated so that Communications can refuse it with a closed reason instead of guessing.
 */
export const CommunicationDocumentRecipientScopeSchema = Schema.Literals(['ANOTHER_RECIPIENT', 'ORIGINAL_RECIPIENT']);
export type CommunicationDocumentRecipientScope = typeof CommunicationDocumentRecipientScopeSchema.Type;

/**
 * One document the message should carry, as a SAFE REFERENCE only: the owner's business document (`document.moduleId` is the
 * owner module that answers for it), the owner's own approved classification key and the recipient scope. It never carries
 * bytes, a URL, a file name or a permission: the owner resolves it to its exact Media Asset and authorizes the disclosure when
 * the message is handed off, and a reference grants nothing.
 */
export const CommunicationDocumentRefSchema = Schema.Struct({
  classification: lowerDottedText.pipe(Schema.brand('CommunicationDocumentClassification')),
  document: CommunicationResourceRefSchema,
  /** Absent means a link, the default form. */
  form: Schema.optionalKey(CommunicationDocumentFormSchema),
  recipientScope: CommunicationDocumentRecipientScopeSchema,
});
export type CommunicationDocumentRef = typeof CommunicationDocumentRefSchema.Type;

const MAX_DOCUMENTS = 4;

const DocumentsSchema = Schema.NonEmptyArray(CommunicationDocumentRefSchema).check(
  Schema.isMaxLength(MAX_DOCUMENTS),
  Schema.makeFilter((documents) =>
    new Set(documents.map(({ document }) => `${document.moduleId}|${document.resourceType}|${document.resourceId}`))
      .size === documents.length
      ? undefined
      : 'a document may be named only once per request',
  ),
);

export const CommunicationRequestSchema = Schema.Struct({
  documents: Schema.optionalKey(DocumentsSchema),
  idempotency: CommunicationIdempotencySchema,
  occurrence: CommunicationSourceOccurrenceSchema,
  originalRecipients: Schema.NonEmptyArray(OriginalRecipientBindingSchema),
  purpose: CommunicationPurposeKeySchema,
  resendOf: Schema.optionalKey(CommunicationResendOfSchema),
  safeReferences: SafeReferencesSchema,
  schemaVersion: Schema.Literal(1),
  scope: CommunicationRequestScopeSchema,
  source: CommunicationRequestSourceSchema,
});
export type CommunicationRequest = typeof CommunicationRequestSchema.Type;
export type CommunicationRequestEncoded = typeof CommunicationRequestSchema.Encoded;
