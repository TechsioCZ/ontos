import { HttpApiSchema } from '@modern-js/bff-effect/effect-client';
import { Schema } from 'effect';

const problemDetailsRepresentation = HttpApiSchema.asJson({ contentType: 'application/problem+json' });

export class CommitmentProtectionVerificationDomainUnavailableProblem extends Schema.TaggedError<CommitmentProtectionVerificationDomainUnavailableProblem>()(
  'CommitmentProtectionVerificationDomainUnavailableProblem',
  {
    detail: Schema.String,
    reasonCode: Schema.Literal('commitment_protection_unavailable'),
    retryable: Schema.Literal(true),
    status: Schema.Literal(503),
    title: Schema.String,
    type: Schema.String,
  },
) {}

export const CommitmentProtectionVerificationDomainUnavailableProblemSchema =
  CommitmentProtectionVerificationDomainUnavailableProblem.pipe(
    problemDetailsRepresentation,
    HttpApiSchema.status(503),
  );
