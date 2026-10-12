import { PrincipalRefSchema } from '@app/core-runtime/permissions/principal-ref';
import { Schema } from 'effect';
import { SalesPipelineScopeMismatch } from '../errors/sales-pipeline-scope-mismatch.ts';
import { SalesPipelineNotFound } from '../errors/sales-pipeline-not-found.ts';
import { SalesPipelineLifecycleConflict } from '../errors/sales-pipeline-lifecycle-conflict.ts';
import { SalesPipelineRevisionConflict } from '../errors/sales-pipeline-revision-conflict.ts';
import { SalesPipelinePersistenceUnavailable } from '../errors/sales-pipeline-persistence-unavailable.ts';
import { SalesPipelineReferenceUnavailable } from '../errors/sales-pipeline-reference-unavailable.ts';
import { SalesPipelineReferenceIneligible } from '../errors/sales-pipeline-reference-ineligible.ts';
import { SalesPipelinePermissionDenied } from '../errors/sales-pipeline-permission-denied.ts';
import {
  CalendarDateSchema,
  ContextRefSchema,
  OpportunityPrioritySchema,
  OpportunitySchema,
  OpportunityStateSchema,
} from '../apis/records.ts';
import { OpportunityRefSchema } from '../resources/opportunity.ts';

const editableFields = {
  description: Schema.optionalKey(Schema.Trim.check(Schema.isMaxLength(2000))),
  dueDate: Schema.optionalKey(CalendarDateSchema),
  ownerPrincipalRef: Schema.optionalKey(PrincipalRefSchema),
  priority: Schema.optionalKey(OpportunityPrioritySchema),
};
export const SalesPipelineCommandSchema = Schema.Union([
  Schema.TaggedStruct('CreateOpportunity', {
    ...editableFields,
    contextRefs: Schema.optionalKey(Schema.Array(ContextRefSchema).check(Schema.isMaxLength(12))),
    title: Schema.Trim.check(Schema.isMinLength(1), Schema.isMaxLength(200)),
  }),
  Schema.TaggedStruct('UpdateOpportunity', {
    ...editableFields,
    opportunityRef: OpportunityRefSchema,
    title: Schema.optionalKey(Schema.Trim.check(Schema.isMinLength(1), Schema.isMaxLength(200))),
  }),
  Schema.TaggedStruct('AssignOpportunity', {
    opportunityRef: OpportunityRefSchema,
    ownerPrincipalRef: PrincipalRefSchema,
  }),
  Schema.TaggedStruct('ChangeOpportunityState', {
    opportunityRef: OpportunityRefSchema,
    state: OpportunityStateSchema,
  }),
]);
export type SalesPipelineCommand = typeof SalesPipelineCommandSchema.Type;
export const ApplyCommandPayloadSchema = Schema.Struct({
  command: SalesPipelineCommandSchema,
  expectedRevision: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
});
export type ApplyCommandPayload = typeof ApplyCommandPayloadSchema.Type;
export const ApplyCommandResultSchema = Schema.Struct({ opportunity: OpportunitySchema, revision: Schema.Int });
export const SalesPipelineErrorSchema = Schema.Union([
  SalesPipelineScopeMismatch,
  SalesPipelineNotFound,
  SalesPipelineLifecycleConflict,
  SalesPipelineRevisionConflict,
  SalesPipelinePersistenceUnavailable,
  SalesPipelineReferenceUnavailable,
  SalesPipelineReferenceIneligible,
  SalesPipelinePermissionDenied,
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
