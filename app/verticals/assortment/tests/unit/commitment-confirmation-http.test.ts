import { expect, it } from 'effect-rstest';

import {
  AssortmentCommitmentConfirmationExpired,
  AssortmentCommitmentConfirmationInvalid,
  AssortmentCommitmentConfirmationScopeMismatch,
  AssortmentCommitmentConfirmationUnavailable,
} from '../../shared/domain/commitment-confirmation.ts';
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
