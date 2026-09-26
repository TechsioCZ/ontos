import { HttpApiSchema } from '@modern-js/bff-effect/effect-client';
import { Schema } from 'effect';

const problemDetailsRepresentation = HttpApiSchema.asJson({ contentType: 'application/problem+json' });

export class InventoryReconciliationEvidenceDomainPolicyProblem extends Schema.TaggedError<InventoryReconciliationEvidenceDomainPolicyProblem>()(
  'InventoryReconciliationEvidenceDomainPolicyProblem',
  {
    detail: Schema.String,
    reasonCode: Schema.Literals(['CORRELATION_NOT_ENDED', 'EVIDENCE_LIMIT_EXCEEDED']),
    status: Schema.Literal(422),
    title: Schema.String,
    type: Schema.String,
  },
) {}

export const InventoryReconciliationEvidenceDomainPolicyProblemSchema =
  InventoryReconciliationEvidenceDomainPolicyProblem.pipe(problemDetailsRepresentation, HttpApiSchema.status(422));
