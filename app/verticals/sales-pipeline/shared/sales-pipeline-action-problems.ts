import { makeProblemDetailsSchema, makeRetryableProblemDetailsSchema } from '@app/shared-contracts/problem-details';
import { Schema } from 'effect';
import type { SalesPipelineNotImplemented } from './errors/sales-pipeline-not-implemented.ts';
import type { SalesPipelineLifecycleConflict } from './errors/sales-pipeline-lifecycle-conflict.ts';
import type { SalesPipelineNotFound } from './errors/sales-pipeline-not-found.ts';
import type { SalesPipelinePermissionDenied } from './errors/sales-pipeline-permission-denied.ts';

export const SalesPipelineNotImplementedProblemSchema = makeRetryableProblemDetailsSchema(
  'SalesPipelineNotImplementedProblem',
  503,
  {
    code: Schema.Literal('sales_pipeline_not_implemented'),
  },
);

export const mapSalesPipelineNotImplementedProblem = (
  _failure: SalesPipelineNotImplemented,
): typeof SalesPipelineNotImplementedProblemSchema.Type =>
  SalesPipelineNotImplementedProblemSchema.make({
    code: 'sales_pipeline_not_implemented',
    detail: 'The Action capability is temporarily unavailable.',
    retryable: true,
    status: 503,
    title: 'Action unavailable',
    type: 'https://ontos.dev/problems/action-unavailable',
  });

export const SalesPipelineLifecycleConflictProblemSchema = makeProblemDetailsSchema(
  'SalesPipelineLifecycleConflictProblem',
  409,
  {
    code: Schema.Literal('sales_pipeline_lifecycle_conflict'),
  },
);

export const mapSalesPipelineLifecycleConflictProblem = (
  failure: SalesPipelineLifecycleConflict,
): typeof SalesPipelineLifecycleConflictProblemSchema.Type =>
  SalesPipelineLifecycleConflictProblemSchema.make({
    code: 'sales_pipeline_lifecycle_conflict',
    detail: failure.reason,
    status: 409,
    title: 'Action conflict',
    type: 'https://ontos.dev/problems/action-conflict',
  });

export const SalesPipelineNotFoundProblemSchema = makeProblemDetailsSchema('SalesPipelineNotFoundProblem', 404, {
  code: Schema.Literal('sales_pipeline_not_found'),
});

export const mapSalesPipelineNotFoundProblem = (
  failure: SalesPipelineNotFound,
): typeof SalesPipelineNotFoundProblemSchema.Type =>
  SalesPipelineNotFoundProblemSchema.make({
    code: 'sales_pipeline_not_found',
    detail: failure.reason,
    status: 404,
    title: 'Resource not found',
    type: 'https://ontos.dev/problems/action-resource-not-found',
  });

export const SalesPipelinePermissionDeniedProblemSchema = makeProblemDetailsSchema(
  'SalesPipelinePermissionDeniedProblem',
  403,
  {
    code: Schema.Literal('sales_pipeline_permission_denied'),
  },
);

export const mapSalesPipelinePermissionDeniedProblem = (
  failure: SalesPipelinePermissionDenied,
): typeof SalesPipelinePermissionDeniedProblemSchema.Type =>
  SalesPipelinePermissionDeniedProblemSchema.make({
    code: 'sales_pipeline_permission_denied',
    detail: failure.reason,
    status: 403,
    title: 'Action forbidden',
    type: 'https://ontos.dev/problems/action-forbidden',
  });
