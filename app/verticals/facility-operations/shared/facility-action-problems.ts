import { makeRetryableProblemDetailsSchema } from '@app/shared-contracts/problem-details';
import { Schema } from 'effect';
import type { FacilityOperationsNotImplemented } from './errors/facility-operations-not-implemented.ts';

export const FacilityOperationsNotImplementedProblemSchema = makeRetryableProblemDetailsSchema(
  'FacilityOperationsNotImplementedProblem',
  503,
  {
    code: Schema.Literal('facility_operations_not_implemented'),
  },
);

export const mapFacilityOperationsNotImplementedProblem = (
  _failure: FacilityOperationsNotImplemented,
): typeof FacilityOperationsNotImplementedProblemSchema.Type =>
  FacilityOperationsNotImplementedProblemSchema.make({
    code: 'facility_operations_not_implemented',
    detail: 'The Action capability is temporarily unavailable.',
    retryable: true,
    status: 503,
    title: 'Action unavailable',
    type: 'https://ontos.dev/problems/action-unavailable',
  });
