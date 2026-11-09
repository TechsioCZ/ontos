import { Schema } from 'effect';

import {
  PaymentActionInvocationIdSchema,
  PaymentCompositionRevisionSchema,
  PaymentPrincipalIdSchema,
} from './payment-identifiers.ts';

/**
 * Truthful execution provenance of one governed write (#1148/#1151 R1/R2): the Core invocation, the
 * approved Composition revision it ran under and the acting principal. A late execution records its
 * own provenance and references the original operation; original rows are never rewritten.
 */
export const PaymentExecutionProvenanceSchema = Schema.Struct({
  actionInvocationId: PaymentActionInvocationIdSchema,
  actorPrincipalId: PaymentPrincipalIdSchema,
  compositionRevision: PaymentCompositionRevisionSchema,
});
export type PaymentExecutionProvenance = typeof PaymentExecutionProvenanceSchema.Type;
