import { makeProblemDetailsSchema } from '@app/shared-contracts/problem-details';
import { Schema } from 'effect';
import type { WorkforceDuplicateEmail } from './errors/workforce-duplicate-email.ts';

export const WorkforceDuplicateEmailProblemSchema = makeProblemDetailsSchema('WorkforceDuplicateEmailProblem', 422, {
  code: Schema.Literal('workforce_duplicate_email'),
});

export const mapWorkforceDuplicateEmailProblem = (
  _failure: WorkforceDuplicateEmail,
): typeof WorkforceDuplicateEmailProblemSchema.Type =>
  WorkforceDuplicateEmailProblemSchema.make({
    code: 'workforce_duplicate_email',
    detail: 'Another employee already uses this email address.',
    status: 422,
    title: 'Employee email is already in use',
    type: 'urn:ontos:workforce:duplicate-email',
  });
