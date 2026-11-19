import { Schema } from 'effect';
import type { DateTime } from 'effect';

import { AudiencePolicySchema } from '../catalog/audience.ts';
import type { CommunicationDecisionRequest } from '../catalog/decision-request.ts';
import type { TransactionalMessageType } from '../catalog/message-type.ts';
import { OntosModuleIdSchema } from '@app/core-runtime/modules/manifest';
import {
  AudienceSlotKeySchema,
  CommunicationOccurrenceIdSchema,
  CommunicationResourceRefSchema,
  MessageTypeIdSchema,
  RecipientRoleSchema,
  RevisionSchema,
} from '../catalog/vocabulary.ts';
import { OriginalContactBindingSchema, RecipientScopeSchema } from './original-binding.ts';
import type { RecipientScope } from './original-binding.ts';
import {
  NotAllowedReasonSchema,
  RecipientAssessment,
  UnavailableAuthoritySchema,
  UnresolvedReasonSchema,
} from './recipient-assessment.ts';
import type { RecipientAssessmentCase } from './recipient-assessment.ts';

/**
 * Safe recipient decision evidence (#1395, BR-11, AC-09): the minimum that proves who was addressed and why, with no
 * usable secret. It holds references and revisions (source occurrence, original contact reference and its evidence,
 * audience policy and the approved rule), the evaluated authorization with its reason and the time, and at most a
 * mask of the endpoint. The endpoint value is `Redacted` and has no field here, so it cannot reach history or a log,
 * and no Auth proof, OTP, reset token or claim URL is representable. Evidence is an immutable value: a later
 * evaluation produces a new value and never rewrites the original recipient decision (BR-10).
 */
export const RecipientAuthorizationSchema = Schema.Literals([
  'RECIPIENT_ALLOWED',
  'RECIPIENT_NOT_ALLOWED',
  'RECIPIENT_UNRESOLVED',
  'SOURCE_UNAVAILABLE',
]);

/** An indivisible group that could not complete stops its otherwise allowed members with their own reason. */
export const EvidenceReasonSchema = Schema.Literals([
  ...NotAllowedReasonSchema.literals,
  ...UnresolvedReasonSchema.literals,
  'AUTHORITY_UNAVAILABLE',
  'AUDIENCE_GROUP_INCOMPLETE',
]);

export const RecipientEvidenceSchema = Schema.Struct({
  audience: AudiencePolicySchema,
  authority: Schema.optional(UnavailableAuthoritySchema),
  authorization: RecipientAuthorizationSchema,
  endpointMask: Schema.optional(Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(80))),
  evaluatedAt: Schema.DateTimeUtcFromString,
  occurrence: Schema.Struct({ occurrenceId: CommunicationOccurrenceIdSchema, revision: RevisionSchema }),
  originalContact: Schema.optional(OriginalContactBindingSchema),
  reason: Schema.optional(EvidenceReasonSchema),
  recipientRef: CommunicationResourceRefSchema,
  role: RecipientRoleSchema,
  scope: RecipientScopeSchema,
  slotKey: AudienceSlotKeySchema,
  sourceModule: OntosModuleIdSchema,
  typeId: MessageTypeIdSchema,
  typeRevision: RevisionSchema,
  validAt: Schema.DateTimeUtcFromString,
});
export type RecipientEvidence = typeof RecipientEvidenceSchema.Type;

export interface RecipientEvidenceContext {
  readonly evaluatedAt: DateTime.Utc;
  readonly request: CommunicationDecisionRequest;
  /** The request's trusted scope. A foreign scope on a mismatching binding is never recorded. */
  readonly scope: RecipientScope;
  readonly type: Pick<TransactionalMessageType, 'audience' | 'revision' | 'typeId'>;
}

const outcomeFields = (assessment: RecipientAssessmentCase) =>
  RecipientAssessment.$match(assessment, {
    RecipientAllowed: ({ endpoint }) => ({
      authorization: 'RECIPIENT_ALLOWED' as const,
      endpointMask: endpoint.mask,
    }),
    RecipientNotAllowed: ({ reason }) => ({ authorization: 'RECIPIENT_NOT_ALLOWED' as const, reason }),
    RecipientUnresolved: ({ reason }) => ({ authorization: 'RECIPIENT_UNRESOLVED' as const, reason }),
    SourceUnavailable: ({ authority }) => ({
      authority,
      authorization: 'SOURCE_UNAVAILABLE' as const,
      reason: 'AUTHORITY_UNAVAILABLE' as const,
    }),
  });

/** Build the evidence of one assessment, as of the evaluation that produced it. */
export const recipientEvidenceOf = (
  assessment: RecipientAssessmentCase,
  context: RecipientEvidenceContext,
): RecipientEvidence => {
  const { binding, slotKey } = assessment.subject;
  return {
    audience: context.type.audience,
    ...outcomeFields(assessment),
    evaluatedAt: context.evaluatedAt,
    occurrence: context.request.occurrence,
    originalContact: binding.originalContact,
    recipientRef: binding.recipientRef,
    role: binding.role,
    scope: context.scope,
    slotKey,
    sourceModule: context.request.source.moduleKey,
    typeId: context.type.typeId,
    typeRevision: context.type.revision,
    validAt: binding.validAt,
  };
};

/**
 * An individually allowed member of an approved indivisible audience that was stopped only because the group could
 * not complete: same facts, its own reason.
 */
export const groupStoppedEvidenceOf = (evidence: RecipientEvidence): RecipientEvidence => ({
  ...evidence,
  reason: 'AUDIENCE_GROUP_INCOMPLETE',
});
