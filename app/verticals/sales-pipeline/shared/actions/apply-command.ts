import { Schema } from 'effect';
import { SalesPipelineScopeMismatch } from '../errors/sales-pipeline-scope-mismatch.ts';
import { SalesPipelineNotFound } from '../errors/sales-pipeline-not-found.ts';
import { SalesPipelineLifecycleConflict } from '../errors/sales-pipeline-lifecycle-conflict.ts';
import { SalesPipelineRevisionConflict } from '../errors/sales-pipeline-revision-conflict.ts';
import { SalesPipelinePersistenceUnavailable } from '../errors/sales-pipeline-persistence-unavailable.ts';
import { SalesPipelineReferenceUnavailable } from '../errors/sales-pipeline-reference-unavailable.ts';
import { SalesPipelineReferenceIneligible } from '../errors/sales-pipeline-reference-ineligible.ts';
import { SalesPipelinePermissionDenied } from '../errors/sales-pipeline-permission-denied.ts';
import { SalesPipelineNotImplemented } from '../errors/sales-pipeline-not-implemented.ts';
import { CalendarDateWireSchema as CalendarDateSchema } from '@app/shared-contracts';
import {
  EmployeeIdSchema,
  OpportunityIdSchema,
  OpportunityStageSchema,
  PartyIdSchema,
} from '../outbox/sales-pipeline-opportunity-stage-changed-v1.ts';
import {
  OpportunityLinesSchema,
  OpportunityNoteSchema,
  OpportunitySchema,
  OpportunityTitleSchema,
  ProbabilitySchema,
} from '../model/opportunity.ts';

export const OpportunityPatchSchema = Schema.Struct({
  expectedCloseDate: Schema.optionalKey(CalendarDateSchema),
  lines: Schema.optionalKey(OpportunityLinesSchema),
  note: Schema.optionalKey(OpportunityNoteSchema),
  partyId: Schema.optionalKey(PartyIdSchema),
  probability: Schema.optionalKey(ProbabilitySchema),
  title: Schema.optionalKey(OpportunityTitleSchema),
});
export type OpportunityPatch = typeof OpportunityPatchSchema.Type;

/** Owner clear is `null` on the wire and `None` in the decoded model. */
export const BulkOpportunityPatchSchema = Schema.Struct({
  ownerEmployeeId: Schema.optionalKey(Schema.OptionFromNullOr(EmployeeIdSchema)),
  stage: Schema.optionalKey(OpportunityStageSchema),
});
export type BulkOpportunityPatch = typeof BulkOpportunityPatchSchema.Type;

export const CreateOpportunityCommandSchema = Schema.TaggedStruct('CreateOpportunity', {
  expectedCloseDate: CalendarDateSchema,
  lines: OpportunityLinesSchema,
  note: Schema.optionalKey(OpportunityNoteSchema),
  ownerEmployeeId: Schema.optionalKey(EmployeeIdSchema),
  partyId: PartyIdSchema,
  probability: Schema.optionalKey(ProbabilitySchema),
  stage: Schema.optionalKey(OpportunityStageSchema),
  title: OpportunityTitleSchema,
});
export const UpdateOpportunityCommandSchema = Schema.TaggedStruct('UpdateOpportunity', {
  id: OpportunityIdSchema,
  patch: OpportunityPatchSchema,
});
export const AssignOpportunityCommandSchema = Schema.TaggedStruct('AssignOpportunity', {
  id: OpportunityIdSchema,
  ownerEmployeeId: Schema.OptionFromNullOr(EmployeeIdSchema),
});
export const ChangeOpportunityStageCommandSchema = Schema.TaggedStruct('ChangeOpportunityStage', {
  id: OpportunityIdSchema,
  note: Schema.optionalKey(OpportunityNoteSchema),
  toStage: OpportunityStageSchema,
});

/** AI level C: the only opportunity operations an agent may PROPOSE. A person approves each one in the app. */
export const SalesPipelineAiOperationSchema = Schema.Union([
  CreateOpportunityCommandSchema,
  UpdateOpportunityCommandSchema,
  AssignOpportunityCommandSchema,
  ChangeOpportunityStageCommandSchema,
]);
export type SalesPipelineAiOperation = typeof SalesPipelineAiOperationSchema.Type;

const AiReasonSchema = Schema.Trim.check(Schema.isMinLength(3), Schema.isMaxLength(2000));
const AiIdSchema = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(300));

/** AI approval commands (shared engine `@app/shared-contracts/ai-approvals`). Decide and revert are human-only. */
export const salesPipelineAiCommandSchemas = [
  Schema.TaggedStruct('AiProposeChanges', {
    agentLabel: Schema.optionalKey(Schema.Trim.check(Schema.isMinLength(1), Schema.isMaxLength(200))),
    changes: Schema.Array(Schema.Struct({ operation: SalesPipelineAiOperationSchema, reason: AiReasonSchema })).check(
      Schema.isMinLength(1),
      Schema.isMaxLength(20),
    ),
    instruction: AiReasonSchema,
    runId: Schema.optionalKey(Schema.Trim.check(Schema.isMinLength(1), Schema.isMaxLength(200))),
  }),
  Schema.TaggedStruct('AiDecideChanges', {
    changeIds: Schema.Array(AiIdSchema).check(Schema.isMinLength(1), Schema.isMaxLength(50)),
    decision: Schema.Literals(['approve', 'reject']),
    note: Schema.optionalKey(Schema.Trim.check(Schema.isMaxLength(2000))),
  }),
  Schema.TaggedStruct('AiRevertBatch', {
    batchId: AiIdSchema,
    note: Schema.optionalKey(Schema.Trim.check(Schema.isMaxLength(2000))),
  }),
] as const;

export const SalesPipelineCommandSchema = Schema.Union([
  CreateOpportunityCommandSchema,
  Schema.TaggedStruct('ArchiveOpportunity', { id: OpportunityIdSchema }),
  UpdateOpportunityCommandSchema,
  AssignOpportunityCommandSchema,
  ChangeOpportunityStageCommandSchema,
  Schema.TaggedStruct('BulkUpdateOpportunities', {
    ids: Schema.Array(OpportunityIdSchema).check(Schema.isMinLength(1), Schema.isMaxLength(200)),
    patch: BulkOpportunityPatchSchema,
  }),
  ...salesPipelineAiCommandSchemas,
]);
export type SalesPipelineCommand = typeof SalesPipelineCommandSchema.Type;

export const ApplyCommandPayloadSchema = Schema.Struct({
  command: SalesPipelineCommandSchema,
  expectedRevision: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
});
export type ApplyCommandPayload = typeof ApplyCommandPayloadSchema.Type;

/** Bulk ids are applied independently; a skipped id is reported with the reason it could not change. */
export const BulkSkipReasonSchema = Schema.Literals(['closed', 'invalid_transition', 'not_found']);
export type BulkSkipReason = typeof BulkSkipReasonSchema.Type;
export const BulkOpportunityResultSchema = Schema.Struct({
  id: OpportunityIdSchema,
  outcome: Schema.Literals(['changed', 'skipped']),
  reason: Schema.optionalKey(BulkSkipReasonSchema),
});
export type BulkOpportunityResult = typeof BulkOpportunityResultSchema.Type;

/**
 * Affected opportunities: one item for single-record commands, every changed item for bulk updates.
 * `results` is present only for bulk updates and lists every requested id in command order.
 */
export const ApplyCommandResultSchema = Schema.Struct({
  /** AI approval commands: the batch id (propose/revert) followed by change ids, or the decided change ids. */
  entityIds: Schema.optionalKey(Schema.Array(Schema.String)),
  opportunities: Schema.Array(OpportunitySchema),
  results: Schema.optionalKey(Schema.Array(BulkOpportunityResultSchema)),
  revision: Schema.Int,
});
export type ApplyCommandResult = typeof ApplyCommandResultSchema.Type;
export const SalesPipelineErrorSchema = Schema.Union([
  SalesPipelineScopeMismatch,
  SalesPipelineNotFound,
  SalesPipelineLifecycleConflict,
  SalesPipelineRevisionConflict,
  SalesPipelinePersistenceUnavailable,
  SalesPipelineReferenceUnavailable,
  SalesPipelineReferenceIneligible,
  SalesPipelinePermissionDenied,
  SalesPipelineNotImplemented,
]);
export type SalesPipelineError = typeof SalesPipelineErrorSchema.Type;
export { SalesPipelineScopeMismatch } from '../errors/sales-pipeline-scope-mismatch.ts';
export { SalesPipelineNotFound } from '../errors/sales-pipeline-not-found.ts';
export { SalesPipelineLifecycleConflict } from '../errors/sales-pipeline-lifecycle-conflict.ts';
export { SalesPipelineRevisionConflict } from '../errors/sales-pipeline-revision-conflict.ts';
export { SalesPipelinePersistenceUnavailable } from '../errors/sales-pipeline-persistence-unavailable.ts';
export { SalesPipelineReferenceUnavailable } from '../errors/sales-pipeline-reference-unavailable.ts';
export { SalesPipelineReferenceIneligible } from '../errors/sales-pipeline-reference-ineligible.ts';
export { SalesPipelinePermissionDenied } from '../errors/sales-pipeline-permission-denied.ts';
export { SalesPipelineNotImplemented } from '../errors/sales-pipeline-not-implemented.ts';
