import { OntosModuleIdSchema } from '@app/core-runtime/modules/manifest';
import { Schema } from 'effect';

import {
  CandidateStopReasonSchema,
  CommunicationOccurrenceIdSchema,
  CommunicationPurposeKeySchema,
  CommunicationResourceRefSchema,
  RecipientRoleSchema,
  RevisionSchema,
  SourceStateKeySchema,
} from './vocabulary.ts';

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
  tenantId: Schema.String.check(Schema.isUUID()).pipe(Schema.brand('CommunicationTenantId')),
});
export type CommunicationDecisionRequest = typeof CommunicationDecisionRequestSchema.Type;

/** Current facts about the source occurrence, read from its owner at decision time. */
export const SourceOccurrenceFactsSchema = Schema.Struct({
  latestRevision: RevisionSchema,
  state: SourceStateKeySchema,
});
export type SourceOccurrenceFacts = typeof SourceOccurrenceFactsSchema.Type;

/**
 * One candidate recipient the recipient algorithm (d21-03) supplies for a role, with the current blocking fact if
 * one exists. The catalog never derives recipients or Privacy outcomes itself.
 */
export const RecipientFactSchema = Schema.Struct({
  ref: CommunicationResourceRefSchema,
  role: RecipientRoleSchema,
  stop: Schema.optional(CandidateStopReasonSchema),
});
export type RecipientFact = typeof RecipientFactSchema.Type;

export interface CommunicationDecisionContext {
  readonly recipients: readonly RecipientFact[];
  readonly source: SourceOccurrenceFacts;
}
