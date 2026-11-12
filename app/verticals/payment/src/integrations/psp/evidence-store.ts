import type { OutboxWorkerHandlerContext, OutboxWorkerLegalEntityScope } from '@app/core-runtime/outbox/worker';
import { Context, Schema } from 'effect';
import type { Effect, Option } from 'effect';

import { PaymentIdSchema, PaymentOperationIdSchema } from '../../../shared/domain/payment-identifiers.ts';
import type { PaymentObservationIdSchema } from '../../../shared/domain/payment-identifiers.ts';
import { GatewayProviderAccountBindingIdSchema } from '../../../shared/domain/psp-configuration.ts';
import {
  ProviderEvidenceOriginSchema,
  ProviderEvidenceSubmissionStateSchema,
} from '../../../shared/domain/psp-vocabulary.ts';
import type { GatewayLedgerUnavailableError } from './psp-errors.ts';
import { ProviderEvidenceSchema } from './psp-result.ts';

/**
 * C17-owned provider evidence (#1158, plan D8). Evidence obtained without a workload-admitted
 * origin stays PENDING_SUBMISSION as visible reconciliation debt until a governed submission.
 */

type OperationId = typeof PaymentOperationIdSchema.Type;

export const ProviderEvidenceIdSchema = Schema.String.check(Schema.isUUID()).pipe(Schema.brand('ProviderEvidenceId'));
export type ProviderEvidenceId = typeof ProviderEvidenceIdSchema.Type;

/** Terminal submission states; PENDING_SUBMISSION moves to exactly one of them. */
export const ProviderEvidenceSubmissionOutcomeSchema = ProviderEvidenceSubmissionStateSchema.pick([
  'ACCEPTED',
  'DUPLICATE',
  'HELD',
  'CONFLICT',
  'DENIED',
]);
export type ProviderEvidenceSubmissionOutcome = typeof ProviderEvidenceSubmissionOutcomeSchema.Type;

export const StoredProviderEvidenceSchema = Schema.Struct({
  bindingId: GatewayProviderAccountBindingIdSchema,
  evidence: ProviderEvidenceSchema,
  evidenceId: ProviderEvidenceIdSchema,
  operationId: PaymentOperationIdSchema,
  origin: ProviderEvidenceOriginSchema,
  paymentId: PaymentIdSchema,
  recordedAt: Schema.DateTimeUtc,
  submissionState: ProviderEvidenceSubmissionStateSchema,
});
export type StoredProviderEvidence = typeof StoredProviderEvidenceSchema.Type;

export interface AppendProviderEvidenceInput {
  readonly bindingId: typeof GatewayProviderAccountBindingIdSchema.Type;
  readonly evidence: typeof ProviderEvidenceSchema.Type;
  readonly operationId: OperationId;
  readonly origin: typeof ProviderEvidenceOriginSchema.Type;
  readonly paymentId: typeof PaymentIdSchema.Type;
  readonly scope: OutboxWorkerLegalEntityScope;
  readonly workerContext: OutboxWorkerHandlerContext;
}

export interface ListPendingProviderEvidenceInput {
  readonly operationId: OperationId;
  readonly scope: OutboxWorkerLegalEntityScope;
}

export interface MarkProviderEvidenceSubmissionInput {
  readonly evidenceId: ProviderEvidenceId;
  readonly observationId: Option.Option<typeof PaymentObservationIdSchema.Type>;
  readonly outcome: ProviderEvidenceSubmissionOutcome;
  readonly scope: OutboxWorkerLegalEntityScope;
  readonly workerContext: OutboxWorkerHandlerContext;
}

export interface ProviderEvidenceStoreContract {
  /** Idempotent on (binding, sourceOccurrenceId, sourceRevision): a repeat returns the existing id. */
  readonly append: (
    input: AppendProviderEvidenceInput,
  ) => Effect.Effect<ProviderEvidenceId, GatewayLedgerUnavailableError>;
  /** Oldest first. */
  readonly listPending: (
    input: ListPendingProviderEvidenceInput,
  ) => Effect.Effect<readonly StoredProviderEvidence[], GatewayLedgerUnavailableError>;
  /** Idempotent for the same outcome; a different terminal outcome for a settled row fails. */
  readonly markSubmission: (
    input: MarkProviderEvidenceSubmissionInput,
  ) => Effect.Effect<StoredProviderEvidence, GatewayLedgerUnavailableError>;
}

export class ProviderEvidenceStore extends Context.Service<ProviderEvidenceStore, ProviderEvidenceStoreContract>()(
  '@app/payment/integrations/psp/evidence-store/ProviderEvidenceStore',
) {}
