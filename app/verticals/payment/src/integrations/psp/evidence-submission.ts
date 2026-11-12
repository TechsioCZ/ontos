import type { OutboxWorkerHandlerContext, OutboxWorkerLegalEntityScope } from '@app/core-runtime/outbox/worker';
import { Context, Schema } from 'effect';
import type { Effect } from 'effect';

import type { PaymentGatewayAccountBinding } from '../../../shared/domain/payment-execution-binding.ts';
import { PaymentObservationIdSchema } from '../../../shared/domain/payment-identifiers.ts';
import { ProviderEvidenceSubmissionOutcomeSchema } from './evidence-store.ts';
import type { StoredProviderEvidence } from './evidence-store.ts';
import type { GatewayProviderUnavailableError } from './psp-errors.ts';

/**
 * Submits C17 provider evidence through the public A8 `accept-payment-observation` Action with a
 * fresh RegisteredWorkload assertion (plan D8). There is no owner-local bypass: a delivery whose
 * original admission was human stays DENIED and its evidence remains reconciliation debt.
 */

export const ProviderEvidenceSubmissionResultSchema = Schema.Struct({
  /** Present for ACCEPTED, DUPLICATE, HELD and CONFLICT when A8 returned an observation. */
  observationId: Schema.Option(PaymentObservationIdSchema),
  outcome: ProviderEvidenceSubmissionOutcomeSchema,
});
export type ProviderEvidenceSubmissionResult = typeof ProviderEvidenceSubmissionResultSchema.Type;

/**
 * Evidence is always appended before it is submitted, so the submission carries the stored row. A8
 * mapping: operationId, paymentId, factKind, factFamily, sourceOccurrenceId, sourceRevision and
 * economicEffectKey from the row; `amount` = `evidence.observedAmount` (its own currency);
 * `sourceOccurredAt` = `evidence.providerOccurredAt`; `receivedAt` = `stored.receivedAt` (never the
 * submission time).
 */
export interface ProviderEvidenceSubmission {
  /** The immutable C16 operation binding: A8 source system, account ref and environment come from it. */
  readonly binding: PaymentGatewayAccountBinding;
  readonly evidence: StoredProviderEvidence;
  readonly scope: OutboxWorkerLegalEntityScope;
  readonly workerContext: OutboxWorkerHandlerContext;
}

export interface ProviderEvidenceSubmitterContract {
  /** UNAVAILABLE means "not decided, retry"; every A8 decision (including denial) is a result. */
  readonly submit: (
    submission: ProviderEvidenceSubmission,
  ) => Effect.Effect<ProviderEvidenceSubmissionResult, GatewayProviderUnavailableError>;
}

export class ProviderEvidenceSubmitter extends Context.Service<
  ProviderEvidenceSubmitter,
  ProviderEvidenceSubmitterContract
>()('@app/payment/integrations/psp/evidence-submission/ProviderEvidenceSubmitter') {}
