import { PrincipalRefSchema } from '@app/core-runtime/permissions/principal-ref';
import { Schema } from 'effect';
import { SalesInsightsScopeMismatch } from '../errors/sales-insights-scope-mismatch.ts';
import { SalesInsightsNotFound } from '../errors/sales-insights-not-found.ts';
import { SalesInsightsLifecycleConflict } from '../errors/sales-insights-lifecycle-conflict.ts';
import { SalesInsightsRevisionConflict } from '../errors/sales-insights-revision-conflict.ts';
import { SalesInsightsPersistenceUnavailable } from '../errors/sales-insights-persistence-unavailable.ts';
import { SalesInsightsReferenceUnavailable } from '../errors/sales-insights-reference-unavailable.ts';
import { SalesInsightsReferenceIneligible } from '../errors/sales-insights-reference-ineligible.ts';
import { SalesInsightsPermissionDenied } from '../errors/sales-insights-permission-denied.ts';
import {
  CalendarDateSchema,
  ContextRefSchema,
  MetricPrioritySchema,
  MetricSchema,
  MetricStateSchema,
} from '../apis/records.ts';
import { MetricRefSchema } from '../resources/metric.ts';

const editableFields = {
  description: Schema.optionalKey(Schema.Trim.check(Schema.isMaxLength(2000))),
  dueDate: Schema.optionalKey(CalendarDateSchema),
  ownerPrincipalRef: Schema.optionalKey(PrincipalRefSchema),
  priority: Schema.optionalKey(MetricPrioritySchema),
};
const ApplyCreateMetricCommandSchema = Schema.TaggedStruct('CreateMetric', {
  ...editableFields,
  contextRefs: Schema.optionalKey(Schema.Array(ContextRefSchema).check(Schema.isMaxLength(12))),
  title: Schema.Trim.check(Schema.isMinLength(1), Schema.isMaxLength(200)),
});

const ApplyUpdateMetricCommandSchema = Schema.TaggedStruct('UpdateMetric', {
  ...editableFields,
  metricRef: MetricRefSchema,
  title: Schema.optionalKey(Schema.Trim.check(Schema.isMinLength(1), Schema.isMaxLength(200))),
});

const ApplyAssignMetricCommandSchema = Schema.TaggedStruct('AssignMetric', {
  metricRef: MetricRefSchema,
  ownerPrincipalRef: PrincipalRefSchema,
});

const ApplyChangeMetricStateCommandSchema = Schema.TaggedStruct('ChangeMetricState', {
  metricRef: MetricRefSchema,
  state: MetricStateSchema,
});

export const SalesInsightsCommandSchema = Schema.Union([
  ApplyCreateMetricCommandSchema,
  ApplyUpdateMetricCommandSchema,
  ApplyAssignMetricCommandSchema,
  ApplyChangeMetricStateCommandSchema,
]);
export type SalesInsightsCommand = typeof SalesInsightsCommandSchema.Type;
export const SalesInsightsCommandPayloadSchema = Schema.Struct({
  command: SalesInsightsCommandSchema,
  expectedRevision: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
});
export type SalesInsightsCommandPayload = typeof SalesInsightsCommandPayloadSchema.Type;
export const ApplyCommandResultSchema = Schema.Struct({ metric: MetricSchema, revision: Schema.Int });
export const SalesInsightsErrorSchema = Schema.Union([
  SalesInsightsScopeMismatch,
  SalesInsightsNotFound,
  SalesInsightsLifecycleConflict,
  SalesInsightsRevisionConflict,
  SalesInsightsPersistenceUnavailable,
  SalesInsightsReferenceUnavailable,
  SalesInsightsReferenceIneligible,
  SalesInsightsPermissionDenied,
]);
export type SalesInsightsError = typeof SalesInsightsErrorSchema.Type;
export { SalesInsightsScopeMismatch } from '../errors/sales-insights-scope-mismatch.ts';
export { SalesInsightsNotFound } from '../errors/sales-insights-not-found.ts';
export { SalesInsightsLifecycleConflict } from '../errors/sales-insights-lifecycle-conflict.ts';
export { SalesInsightsRevisionConflict } from '../errors/sales-insights-revision-conflict.ts';
export { SalesInsightsPersistenceUnavailable } from '../errors/sales-insights-persistence-unavailable.ts';
export { SalesInsightsReferenceUnavailable } from '../errors/sales-insights-reference-unavailable.ts';
export { SalesInsightsReferenceIneligible } from '../errors/sales-insights-reference-ineligible.ts';
export { SalesInsightsPermissionDenied } from '../errors/sales-insights-permission-denied.ts';

/** Scope-wide creation. Existing-record mutations have their own target-bearing Actions. */
export const ApplyCommandPayloadSchema = Schema.Struct({
  command: ApplyCreateMetricCommandSchema,
  expectedRevision: SalesInsightsCommandPayloadSchema.fields.expectedRevision,
});
export const UpdateMetricPayloadSchema = Schema.Struct({
  command: ApplyUpdateMetricCommandSchema,
  expectedRevision: SalesInsightsCommandPayloadSchema.fields.expectedRevision,
});
export const AssignMetricPayloadSchema = Schema.Struct({
  command: ApplyAssignMetricCommandSchema,
  expectedRevision: SalesInsightsCommandPayloadSchema.fields.expectedRevision,
});
export const ChangeMetricStatePayloadSchema = Schema.Struct({
  command: ApplyChangeMetricStateCommandSchema,
  expectedRevision: SalesInsightsCommandPayloadSchema.fields.expectedRevision,
});

export type ApplyCommandPayload = typeof ApplyCommandPayloadSchema.Type;
