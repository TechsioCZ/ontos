import { Schema } from 'effect';
import { expect, it } from 'effect-rstest';
import { FacilityOperationsNotImplemented } from '../../shared/errors/facility-operations-not-implemented.ts';
import {
  FacilityOperationsNotImplementedProblemSchema,
  mapFacilityOperationsNotImplementedProblem,
} from '../../shared/facility-action-problems.ts';

it('preserves the unavailable 503 contract without exposing the internal cause or placeholder reason', () => {
  const failure = Object.defineProperty(
    new FacilityOperationsNotImplemented({
      code: 'facility_operations_not_implemented',
      reason: 'internal-placeholder',
    }),
    'cause',
    { value: new Error('private-driver-secret') },
  );
  const problem = mapFacilityOperationsNotImplementedProblem(failure);
  expect(Schema.is(FacilityOperationsNotImplementedProblemSchema)(problem)).toBe(true);
  expect(problem.status).toBe(503);
  expect(problem.retryable).toBe(true);
  expect(problem.code).toBe(failure.code);
  expect(JSON.stringify(problem)).not.toMatch(/internal-placeholder|private-driver-secret|stack|cause/u);
});
