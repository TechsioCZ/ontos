import { OntosModuleIdSchema } from '@app/core-runtime/modules/manifest';
import { Schema } from 'effect';

import {
  CommunicationOccurrenceIdSchema,
  CommunicationPurposeKeySchema,
  CommunicationResourceRefSchema,
  CommunicationTenantIdSchema,
  PrivacyEvidenceSchema,
  RecipientRoleSchema,
  RecipientStopReasonSchema,
  RevisionSchema,
  SourceStateKeySchema,
} from './vocabulary.ts';
import type { ResendRefusal } from './vocabulary.ts';

/**
 * What the Communication Decision needs from a committed source Communication Request. Only a request names an
 * occurrence, a purpose and the owner that issued it; a bare Domain Event has none of these and cannot be decoded
 * into one. The intake Action (a later plan) decodes the public contract request at its boundary, rejecting unknown
 * fields, and maps it onto this shape.
 */
export const CommunicationDecisionRequestSchema = Schema.Struct({
  occurrence: Schema.Struct({ occurrenceId: CommunicationOccurrenceIdSchema, revision: RevisionSchema }),
  purpose: CommunicationPurposeKeySchema,
  source: Schema.Struct({ moduleKey: OntosModuleIdSchema }),
  tenantId: CommunicationTenantIdSchema,
});
export type CommunicationDecisionRequest = typeof CommunicationDecisionRequestSchema.Type;

/**
 * Current facts about the source occurrence, read from its owner at decision time. They name the occurrence and
 * tenant they were read for, so facts read for another request are rejected instead of silently applied.
 */
export const SourceOccurrenceFactsSchema = Schema.Struct({
  latestRevision: RevisionSchema,
  occurrenceId: CommunicationOccurrenceIdSchema,
  state: SourceStateKeySchema,
  tenantId: CommunicationTenantIdSchema,
});
export type SourceOccurrenceFacts = typeof SourceOccurrenceFactsSchema.Type;

/**
 * One candidate recipient the recipient algorithm (d21-03) supplies for a role. This is the contract d21-03/d21-04
 * build on. The catalog never derives recipients or Privacy outcomes itself, but it never assumes them either:
 * - `privacy` is REQUIRED positive evidence from the Privacy gate; only `ALLOWED` with no `recipientStop` yields an
 *   eligible candidate, so a caller that never consulted Privacy cannot obtain eligibility;
 * - `recipientStop` is the optional recipient/basis stop fact besides Privacy;
 * - `occurrenceId` and `tenantId` bind the fact to the request it was gathered for.
 */
export const RecipientFactSchema = Schema.Struct({
  occurrenceId: CommunicationOccurrenceIdSchema,
  privacy: PrivacyEvidenceSchema,
  recipientStop: Schema.optional(RecipientStopReasonSchema),
  ref: CommunicationResourceRefSchema,
  role: RecipientRoleSchema,
  tenantId: CommunicationTenantIdSchema,
});
export type RecipientFact = typeof RecipientFactSchema.Type;

export interface CommunicationDecisionContext {
  readonly recipients: readonly RecipientFact[];
  /**
   * Why an Explicit Resend request (#1403) is not admitted, decided by the intake over the approved type and the original
   * intent; absent for an ordinary request and for an admitted resend. A refused resend produces no message.
   */
  readonly resendRefusal?: ResendRefusal;
  readonly source: SourceOccurrenceFacts;
}
