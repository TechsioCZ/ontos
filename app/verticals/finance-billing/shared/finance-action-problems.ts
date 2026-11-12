import { makeProblemDetailsSchema, makeRetryableProblemDetailsSchema } from '@app/shared-contracts/problem-details';
import { Schema } from 'effect';
import type { FinanceConflict } from './actions/errors/finance-conflict.ts';
import type { FinanceNotFound } from './actions/errors/finance-not-found.ts';
import type { FinancePersistenceUnavailable } from './actions/errors/finance-persistence-unavailable.ts';
import type { FinanceReferenceUnavailable } from './actions/errors/finance-reference-unavailable.ts';
import type { FinanceRejected } from './actions/errors/finance-rejected.ts';

export const FinanceConflictProblemSchema = makeProblemDetailsSchema('FinanceConflictProblem', 409, {
  code: Schema.Literal('finance_conflict'),
});

export const mapFinanceConflictProblem = (failure: FinanceConflict): typeof FinanceConflictProblemSchema.Type =>
  FinanceConflictProblemSchema.make({
    code: 'finance_conflict',
    detail: failure.reason,
    status: FinanceConflictProblemSchema.fields.status.literal,
    title: 'Action conflict',
    type: 'https://ontos.dev/problems/action-conflict',
  });

export const FinanceNotFoundProblemSchema = makeProblemDetailsSchema('FinanceNotFoundProblem', 404, {
  code: Schema.Literal('finance_not_found'),
});

export const mapFinanceNotFoundProblem = (failure: FinanceNotFound): typeof FinanceNotFoundProblemSchema.Type =>
  FinanceNotFoundProblemSchema.make({
    code: 'finance_not_found',
    detail: failure.reason,
    status: FinanceNotFoundProblemSchema.fields.status.literal,
    title: 'Resource not found',
    type: 'https://ontos.dev/problems/action-resource-not-found',
  });

export const FinancePersistenceUnavailableProblemSchema = makeRetryableProblemDetailsSchema(
  'FinancePersistenceUnavailableProblem',
  503,
  {
    code: Schema.Literal('finance_persistence_unavailable'),
  },
);

export const mapFinancePersistenceUnavailableProblem = (
  failure: FinancePersistenceUnavailable,
): typeof FinancePersistenceUnavailableProblemSchema.Type =>
  FinancePersistenceUnavailableProblemSchema.make({
    code: 'finance_persistence_unavailable',
    detail: failure.reason,
    retryable: true,
    status: FinancePersistenceUnavailableProblemSchema.fields.status.literal,
    title: 'Action unavailable',
    type: 'https://ontos.dev/problems/action-unavailable',
  });

export const FinanceReferenceUnavailableProblemSchema = makeRetryableProblemDetailsSchema(
  'FinanceReferenceUnavailableProblem',
  503,
  {
    code: Schema.Literal('finance_reference_unavailable'),
  },
);

export const mapFinanceReferenceUnavailableProblem = (
  failure: FinanceReferenceUnavailable,
): typeof FinanceReferenceUnavailableProblemSchema.Type =>
  FinanceReferenceUnavailableProblemSchema.make({
    code: 'finance_reference_unavailable',
    detail: failure.reason,
    retryable: true,
    status: FinanceReferenceUnavailableProblemSchema.fields.status.literal,
    title: 'Action unavailable',
    type: 'https://ontos.dev/problems/action-unavailable',
  });

export const FinanceRejectedProblemSchema = makeProblemDetailsSchema('FinanceRejectedProblem', 422, {
  code: Schema.Literal('finance_rejected'),
});

export const mapFinanceRejectedProblem = (failure: FinanceRejected): typeof FinanceRejectedProblemSchema.Type =>
  FinanceRejectedProblemSchema.make({
    code: 'finance_rejected',
    detail: failure.reason,
    status: FinanceRejectedProblemSchema.fields.status.literal,
    title: 'Action ineligible',
    type: 'https://ontos.dev/problems/action-ineligible',
  });
