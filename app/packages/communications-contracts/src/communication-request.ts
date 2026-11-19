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
  revision: Schema.Int.check(Schema.isGreaterThanOrEqualTo(1), Schema.isLessThanOrEqualTo(2_147_483_647)),
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
  originalRecipientRef: CommunicationResourceRefSchema,
  purpose: CommunicationPurposeKeySchema,
  safeReferences: SafeReferencesSchema,
  schemaVersion: Schema.Literal(1),
  scope: CommunicationRequestScopeSchema,
  source: CommunicationRequestSourceSchema,
});
export type CommunicationRequest = typeof CommunicationRequestSchema.Type;
export type CommunicationRequestEncoded = typeof CommunicationRequestSchema.Encoded;
