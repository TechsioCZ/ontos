import { HttpApiSchema } from '@modern-js/bff-effect/effect-client';
import { Schema } from 'effect';

const problemDetailsRepresentation = HttpApiSchema.asJson({ contentType: 'application/problem+json' });

export class InventoryReconciliationEvidenceDomainUnavailableProblem extends Schema.TaggedError<InventoryReconciliationEvidenceDomainUnavailableProblem>()(
  'InventoryReconciliationEvidenceDomainUnavailableProblem',
  {
    detail: Schema.String,
    reasonCode: Schema.Literal('inventory_reconciliation_evidence_unavailable'),
    retryable: Schema.Literal(true),
    status: Schema.Literal(503),
    title: Schema.String,
    type: Schema.String,
  },
) {}

export const InventoryReconciliationEvidenceDomainUnavailableProblemSchema =
  InventoryReconciliationEvidenceDomainUnavailableProblem.pipe(problemDetailsRepresentation, HttpApiSchema.status(503));
