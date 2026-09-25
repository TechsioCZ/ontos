import { HttpApiSchema } from '@modern-js/bff-effect/effect-client';
import { Schema } from 'effect';

const problemDetailsRepresentation = HttpApiSchema.asJson({ contentType: 'application/problem+json' });

export class CommitmentProtectionVerificationDomainConflictProblem extends Schema.TaggedError<CommitmentProtectionVerificationDomainConflictProblem>()(
  'CommitmentProtectionVerificationDomainConflictProblem',
  {
    detail: Schema.String,
    reasonCode: Schema.Literal('commitment_protection_scope_conflict'),
    status: Schema.Literal(409),
    title: Schema.String,
    type: Schema.String,
  },
) {}

export const CommitmentProtectionVerificationDomainConflictProblemSchema =
  CommitmentProtectionVerificationDomainConflictProblem.pipe(problemDetailsRepresentation, HttpApiSchema.status(409));
