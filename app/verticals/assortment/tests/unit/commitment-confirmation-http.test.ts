import { Schema } from 'effect';
import { expect, it } from 'effect-rstest';

import {
  AssortmentCommitmentConfirmationExpired,
  AssortmentCommitmentConfirmationInvalid,
  AssortmentCommitmentConfirmationScopeMismatch,
  AssortmentCommitmentConfirmationUnavailable,
} from '../../shared/domain/commitment-confirmation.ts';
import { IssueAssortmentCommitmentConfirmationActionUnavailableProblemSchema } from '../../shared/apis/issue-assortment-commitment-confirmation-action.ts';
import { mapIssueAssortmentCommitmentConfirmationActionProblem } from '../../api/issue-assortment-commitment-confirmation-action-problems.ts';

it('maps Confirmation domain failures to fail-closed generated HTTP statuses', () => {
  const failures = [
    {
      error: new AssortmentCommitmentConfirmationInvalid({
        code: 'assortment_confirmation_invalid',
        reason: 'incomplete proof',
      }),
      status: 422,
    },
    {
      error: new AssortmentCommitmentConfirmationExpired({
        code: 'assortment_confirmation_expired',
        reason: 'expired proof',
      }),
      status: 422,
    },
    {
      error: new AssortmentCommitmentConfirmationScopeMismatch({
        code: 'assortment_confirmation_scope_mismatch',
        reason: 'wrong Attempt',
      }),
      status: 403,
    },
    {
      error: new AssortmentCommitmentConfirmationUnavailable({
        code: 'assortment_confirmation_unavailable',
        reason: 'upstream unavailable',
      }),
      status: 503,
    },
  ] as const;

  for (const { error, status } of failures) {
    expect(mapIssueAssortmentCommitmentConfirmationActionProblem(error).status).toBe(status);
  }
});

it('declares and decodes the generated retryable Confirmation problem', () => {
  expect(IssueAssortmentCommitmentConfirmationActionUnavailableProblemSchema.ast.annotations?.httpApiStatus).toBe(503);
  const problem = IssueAssortmentCommitmentConfirmationActionUnavailableProblemSchema.make({
    code: 'assortment_confirmation_unavailable',
    detail: 'The Confirmation capability is temporarily unavailable.',
    retryable: true,
    status: 503,
    title: 'Action unavailable',
    type: 'https://ontos.dev/problems/action-unavailable',
  });
  expect(
    Schema.decodeUnknownSync(IssueAssortmentCommitmentConfirmationActionUnavailableProblemSchema)(problem),
  ).toEqual(problem);
});
