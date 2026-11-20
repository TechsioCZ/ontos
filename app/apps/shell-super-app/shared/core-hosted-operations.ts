import { makeProblemDetailsSchema, makeRetryableProblemDetailsSchema } from '@app/shared-contracts/problem-details';

/*
 * The problems of the Core operations the Shell host serves to modules (#1443): the same sanitized governed-read
 * vocabulary a vertical's receiver answers, so a calling module maps the status exactly like any provider's.
 */
export const CoreHostedOperationAuthenticationProblemSchema = makeProblemDetailsSchema(
  'CoreHostedOperationAuthenticationProblem',
  401,
);
export const CoreHostedOperationInvalidProblemSchema = makeProblemDetailsSchema(
  'CoreHostedOperationInvalidProblem',
  400,
);
export const CoreHostedOperationForbiddenProblemSchema = makeProblemDetailsSchema(
  'CoreHostedOperationForbiddenProblem',
  403,
);
export const CoreHostedOperationNotFoundProblemSchema = makeProblemDetailsSchema(
  'CoreHostedOperationNotFoundProblem',
  404,
);
export const CoreHostedOperationPolicyConflictProblemSchema = makeProblemDetailsSchema(
  'CoreHostedOperationPolicyConflictProblem',
  409,
);
export const CoreHostedOperationPolicyProblemSchema = makeProblemDetailsSchema('CoreHostedOperationPolicyProblem', 422);
export const CoreHostedOperationInternalProblemSchema = makeProblemDetailsSchema(
  'CoreHostedOperationInternalProblem',
  500,
);
export const CoreHostedOperationUnavailableProblemSchema = makeRetryableProblemDetailsSchema(
  'CoreHostedOperationUnavailableProblem',
  503,
);

export const coreHostedOperationErrors = [
  CoreHostedOperationInvalidProblemSchema,
  CoreHostedOperationAuthenticationProblemSchema,
  CoreHostedOperationForbiddenProblemSchema,
  CoreHostedOperationNotFoundProblemSchema,
  CoreHostedOperationPolicyConflictProblemSchema,
  CoreHostedOperationPolicyProblemSchema,
  CoreHostedOperationUnavailableProblemSchema,
  CoreHostedOperationInternalProblemSchema,
] as const;
