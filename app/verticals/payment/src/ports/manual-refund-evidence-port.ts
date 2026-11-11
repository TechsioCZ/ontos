import { Context, Schema } from 'effect';
import type { Effect } from 'effect';

import {
  PaymentEconomicEffectKeySchema,
  PaymentEvidenceRefSchema,
  PaymentIdSchema,
  PaymentMaterialHashSchema,
  PaymentObservationIdSchema,
  PaymentOperationIdSchema,
  PaymentSourceOccurrenceIdSchema,
} from '../../shared/domain/payment-identifiers.ts';
import { PaymentMonetaryAmountSchema } from '../../shared/domain/payment-money.ts';
import type { PaymentUnavailable } from '../../shared/domain/payment-unavailable.ts';
import { PaymentRefundExecutionRouteSchema } from '../../shared/domain/refund-contract.ts';
import type { PaymentRefundExecutionRoute } from '../../shared/domain/refund-contract.ts';
import { paymentSourceStatementFields } from '../../shared/domain/source-statement.ts';
import { PaymentOwnerScopeSchema } from './owner-evidence-unavailable.ts';
import type { PaymentOwnerScope } from './owner-evidence-unavailable.ts';

export const PaymentManualRefundVerifiedFactSchema = Schema.Literals([
  'REFUND_CONFIRMED',
  'REFUND_NOT_EFFECTED',
  'REFUND_INDETERMINATE',
  'SOURCE_CORRECTION',
]);

/**
 * The configured manual executor's retained, verified evidence for one refund (#1152).
 * The executor establishes the permitted destination under its own contract. This record contains
 * only opaque evidence references and exact correlation, never raw account or transfer data.
 */
export const PaymentManualRefundEvidenceSchema = Schema.Struct({
  claim: Schema.Struct({
    amount: Schema.optional(PaymentMonetaryAmountSchema),
    correctsObservationId: Schema.optional(PaymentObservationIdSchema),
    economicEffectKey: Schema.optional(PaymentEconomicEffectKeySchema),
    evidenceRef: PaymentEvidenceRefSchema,
    factKind: PaymentManualRefundVerifiedFactSchema,
    sourceOccurredAt: Schema.optional(Schema.DateTimeUtcFromString),
    sourceOccurrenceId: PaymentSourceOccurrenceIdSchema,
    sourceRevision: paymentSourceStatementFields.sourceRevision,
  }),
  destinationEvidenceRef: PaymentEvidenceRefSchema,
  materialHash: PaymentMaterialHashSchema,
  operationId: PaymentOperationIdSchema,
  paymentId: PaymentIdSchema,
  refundExecutionRoute: PaymentRefundExecutionRouteSchema,
  scope: PaymentOwnerScopeSchema,
  targetOperationId: PaymentOperationIdSchema,
});
export type PaymentManualRefundEvidence = typeof PaymentManualRefundEvidenceSchema.Type;

export interface PaymentManualRefundEvidenceService {
  /** Resolve an immutable evidence record through the original authorized executor, in trusted scope. */
  readonly verify: (input: {
    readonly evidenceRef: string;
    readonly refundExecutionRoute: PaymentRefundExecutionRoute;
    readonly scope: PaymentOwnerScope;
  }) => Effect.Effect<PaymentManualRefundEvidence, PaymentUnavailable>;
}

export class ManualRefundEvidencePort extends Context.Service<
  ManualRefundEvidencePort,
  PaymentManualRefundEvidenceService
>()('@app/payment/ports/manual-refund-evidence-port/ManualRefundEvidencePort') {}
