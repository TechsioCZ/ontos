import { OntosModuleIdSchema } from '@app/core-runtime/modules/manifest';
import { Schema } from 'effect';

/**
 * Closed vocabulary of the Transactional Message Type catalog and the Communication Decision. Keys are stable,
 * lower dotted identifiers; none of them carries message copy, a template, a language or a recipient address.
 */

const lowerDottedText = Schema.String.check(
  Schema.isMinLength(1),
  Schema.isMaxLength(120),
  Schema.isPattern(/^[a-z][a-z0-9]*(?:-[a-z0-9]+)*(?:\.[a-z][a-z0-9]*(?:-[a-z0-9]+)*)*$/u),
);

const opaqueText = Schema.String.check(
  Schema.isMinLength(1),
  Schema.isMaxLength(200),
  Schema.isPattern(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/u),
);

/** Stable identity of one approved Transactional Message Type. */
export const MessageTypeIdSchema = lowerDottedText.pipe(Schema.brand('CommunicationMessageTypeId'));
export type MessageTypeId = typeof MessageTypeIdSchema.Type;

/** The reason a source asks for a communication; the same key the public Communication Request carries. */
export const CommunicationPurposeKeySchema = lowerDottedText.pipe(Schema.brand('CommunicationPurposeKey'));
export type CommunicationPurposeKey = typeof CommunicationPurposeKeySchema.Type;

/** Source occurrence state a type is eligible for, named by the source owner's contract. */
export const SourceStateKeySchema = lowerDottedText.pipe(Schema.brand('CommunicationSourceStateKey'));

/**
 * The closed reasons a source owner's own lifecycle can stop a message with, each its OWN fact in the history (#1406): the issued
 * thing expired, was consumed, was revoked, can no longer be continued by its owner (NOT_RESUMABLE) or was replaced by a newer
 * one (SUPERSEDED). A type declares which of its source states means which (`ineligibleSourceStates`); a state it does not
 * declare stays the generic `SOURCE_STATE_INELIGIBLE`.
 */
export const SourceStopReasonSchema = Schema.Literals([
  'SOURCE_CONSUMED',
  'SOURCE_EXPIRED',
  'SOURCE_NOT_RESUMABLE',
  'SOURCE_REVOKED',
  'SOURCE_SUPERSEDED',
]);
export type SourceStopReason = typeof SourceStopReasonSchema.Type;

/** Reference to a Privacy purpose; resolved by the Privacy gate, never interpreted by the catalog. */
export const PrivacyPurposeKeySchema = lowerDottedText.pipe(Schema.brand('CommunicationPrivacyPurposeKey'));
export type PrivacyPurposeKey = typeof PrivacyPurposeKeySchema.Type;

/** Role a recipient plays for one audience slot, for example `original-recipient`. */
export const RecipientRoleSchema = lowerDottedText.pipe(Schema.brand('CommunicationRecipientRole'));
export type RecipientRole = typeof RecipientRoleSchema.Type;

/** Stable key of one audience slot inside one type. */
export const AudienceSlotKeySchema = lowerDottedText.pipe(Schema.brand('CommunicationAudienceSlotKey'));
export type AudienceSlotKey = typeof AudienceSlotKeySchema.Type;

/** Key of the approved rule behind an explicit no-message result. */
export const ApprovedRuleKeySchema = lowerDottedText.pipe(Schema.brand('CommunicationApprovedRuleKey'));
export type ApprovedRuleKey = typeof ApprovedRuleKeySchema.Type;

export const CommunicationOccurrenceIdSchema = opaqueText.pipe(Schema.brand('CommunicationOccurrenceId'));
export type CommunicationOccurrenceId = typeof CommunicationOccurrenceIdSchema.Type;

export const CommunicationResourceIdSchema = opaqueText.pipe(Schema.brand('CommunicationResourceId'));

/** Type key of an owner resource, for example `party.registry.contact-point`. */
export const CommunicationResourceTypeSchema = lowerDottedText;

/** Structural reference to an owner resource; never a copy of it and never an address. */
export const CommunicationResourceRefSchema = Schema.Struct({
  moduleId: OntosModuleIdSchema,
  resourceId: CommunicationResourceIdSchema,
  resourceType: CommunicationResourceTypeSchema,
});
export type CommunicationResourceRef = typeof CommunicationResourceRefSchema.Type;

/** Module, type and id never contain `|` (closed key vocabularies), so this joins a full reference unambiguously. */
export const resourceRefKey = (ref: CommunicationResourceRef) =>
  `${ref.moduleId}|${ref.resourceType}|${ref.resourceId}`;

/** Positive revision counter shared by source occurrences and catalog types. */
export const RevisionSchema = Schema.Int.check(
  Schema.isGreaterThanOrEqualTo(1),
  Schema.isLessThanOrEqualTo(2_147_483_647),
);

/** Lifecycle of an approved type: only ACTIVE can ever be sent. STALE means its approved rule is no longer current. */
export const MessageTypeStatusSchema = Schema.Literals(['ACTIVE', 'DEACTIVATED', 'STALE']);

/** Whether the source owner has an active onboarding contract for the type; declaring a type activates nothing. */
export const SourceOnboardingSchema = Schema.Literals(['ACTIVE', 'NOT_ACTIVATED']);

/** Business-required or optional meaning. Required never bypasses Privacy, recipient or scope gates. */
export const RequirednessSchema = Schema.Literals(['REQUIRED', 'OPTIONAL']);
export type Requiredness = typeof RequirednessSchema.Type;

/** Current tenant of a request and of every fact evaluated for it. */
export const CommunicationTenantIdSchema = Schema.String.check(Schema.isUUID()).pipe(
  Schema.brand('CommunicationTenantId'),
);
export type CommunicationTenantId = typeof CommunicationTenantIdSchema.Type;

/**
 * Current Privacy Processing Eligibility for one candidate's exact purpose and scope, as the Privacy gate reported it.
 * It is positive evidence: only an explicit `ALLOWED` can ever lead to an eligible candidate. A caller that never
 * consulted Privacy has no value to supply, so absence of a verdict can never be read as permission (#1396).
 * `NOT_ALLOWED` (a proven prohibition) and `INDETERMINATE` (uncertainty) stay distinct and are never merged.
 */
export const PrivacyEvidenceSchema = Schema.Literals(['ALLOWED', 'NOT_ALLOWED', 'INDETERMINATE']);
export type PrivacyEvidence = typeof PrivacyEvidenceSchema.Type;

/** Stop facts the recipient algorithm (#1395, `domain/recipient`) can report besides Privacy. */
export const RecipientStopReasonSchema = Schema.Literals([
  'RECIPIENT_NOT_ELIGIBLE',
  'RECIPIENT_AUTHORITY_UNAVAILABLE',
  'RECIPIENT_BASIS_MISSING',
]);

/**
 * Why one concrete candidate was stopped. Each is a distinct, current, owner-decided fact. RECIPIENT_AUTHORITY_UNAVAILABLE
 * is uncertainty about a mandatory owner, never a proven prohibition; AUDIENCE_GROUP_INCOMPLETE stops an otherwise
 * eligible member of an approved indivisible audience because another required member could not proceed.
 */
const CandidateStopReasonSchema = Schema.Literals([
  'PRIVACY_NOT_ALLOWED',
  'PRIVACY_INDETERMINATE',
  'RECIPIENT_NOT_ELIGIBLE',
  'RECIPIENT_AUTHORITY_UNAVAILABLE',
  'RECIPIENT_BASIS_MISSING',
  'AUDIENCE_GROUP_INCOMPLETE',
]);
export type CandidateStopReason = typeof CandidateStopReasonSchema.Type;

/**
 * Why an Explicit Resend request (#1403) produced no message. They are NO_MESSAGE reasons of the decision, so the source
 * workflow learns a concrete closed reason through the ordinary outcome feed and nothing is created:
 * - RESEND_NOT_APPROVED: the approved type does not carry the source owner's resend approval;
 * - RESEND_ORIGINAL_NOT_FOUND: no intent of the same source owner in this Tenant has that identity;
 * - RESEND_ORIGINAL_TYPE_MISMATCH: the original is a message of another type;
 * - RESEND_ORIGINAL_EFFECT_UNKNOWN: it is not known whether the original left, so it is reconciled before anything is resent.
 */
export const ResendRefusalSchema = Schema.Literals([
  'RESEND_NOT_APPROVED',
  'RESEND_ORIGINAL_NOT_FOUND',
  'RESEND_ORIGINAL_TYPE_MISMATCH',
  'RESEND_ORIGINAL_EFFECT_UNKNOWN',
]);
export type ResendRefusal = typeof ResendRefusalSchema.Type;
