import { Schema } from 'effect';
import { expect, it } from 'effect-rstest';
import {
  FinanceConflict,
  FinanceNotFound,
  FinancePersistenceUnavailable,
  FinanceReferenceUnavailable,
  FinanceRejected,
} from '../../shared/actions/apply-command.ts';
import {
  FinanceConflictProblemSchema,
  FinanceNotFoundProblemSchema,
  FinancePersistenceUnavailableProblemSchema,
  FinanceReferenceUnavailableProblemSchema,
  FinanceRejectedProblemSchema,
  mapFinanceConflictProblem,
  mapFinanceNotFoundProblem,
  mapFinancePersistenceUnavailableProblem,
  mapFinanceReferenceUnavailableProblem,
  mapFinanceRejectedProblem,
} from '../../shared/finance-action-problems.ts';

it('preserves all reviewed safe domain details and statuses without projecting causes or stacks', () => {
  const reason = 'counterparty_role_not_usable';
  const problems = [
    mapFinanceConflictProblem(new FinanceConflict({ code: 'finance_conflict', reason })),
    mapFinanceNotFoundProblem(new FinanceNotFound({ code: 'finance_not_found', reason })),
    mapFinancePersistenceUnavailableProblem(
      Object.defineProperty(
        new FinancePersistenceUnavailable({ code: 'finance_persistence_unavailable', reason }),
        'cause',
        { value: new Error('private-driver-secret') },
      ),
    ),
    mapFinanceReferenceUnavailableProblem(
      new FinanceReferenceUnavailable({ code: 'finance_reference_unavailable', reason }),
    ),
    mapFinanceRejectedProblem(new FinanceRejected({ code: 'finance_rejected', reason })),
  ];
  expect(problems.map((problem) => problem.status)).toEqual([409, 404, 503, 503, 422]);
  for (const problem of problems) {
    expect(problem.detail).toBe(reason);
    expect(JSON.stringify(problem)).not.toMatch(/private-driver-secret|stack|cause/u);
  }
  expect(Schema.is(FinanceConflictProblemSchema)(problems[0])).toBe(true);
  expect(Schema.is(FinanceNotFoundProblemSchema)(problems[1])).toBe(true);
  expect(Schema.is(FinancePersistenceUnavailableProblemSchema)(problems[2])).toBe(true);
  expect(Schema.is(FinanceReferenceUnavailableProblemSchema)(problems[3])).toBe(true);
  expect(Schema.is(FinanceRejectedProblemSchema)(problems[4])).toBe(true);
});
