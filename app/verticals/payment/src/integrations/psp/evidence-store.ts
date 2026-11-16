import type { OutboxWorkerHandlerContext, OutboxWorkerLegalEntityScope } from '@app/core-runtime/outbox/worker';
import { Context, Schema } from 'effect';
import type { Effect, Option } from 'effect';

import {
  PaymentIdSchema,
  PaymentOperationIdSchema,
  PaymentPrincipalIdSchema,
} from '../../../shared/domain/payment-identifiers.ts';
import type { PaymentObservationIdSchema } from '../../../shared/domain/payment-identifiers.ts';
import { GatewayProviderAccountBindingIdSchema } from '../../../shared/domain/psp-configuration.ts';
import {
  ProviderEvidenceOriginSchema,
  ProviderEvidenceSubmissionStateSchema,
} from '../../../shared/domain/psp-vocabulary.ts';
import { ProviderNotificationIdSchema } from './notification-store.ts';
import type { GatewayEvidenceConflictError, GatewayLedgerUnavailableError } from './psp-errors.ts';
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

/**
 * One stored evidence row. `receivedAt` is the durable transport receipt of what proved the fact: the
 * captured notification's `receivedAt` when the evidence came from a notification (taken by the ledger
 * from the notification row of the same binding), otherwise `evidence.observedAt`. `verifiedAt` is
 * `evidence.observedAt`, never earlier than `receivedAt`. The A8 submitter sends `receivedAt` as the
 * statement `receivedAt`; neither is ever replaced by `recordedAt` or the submission time.
 */
export const StoredProviderEvidenceSchema = Schema.Struct({
  bindingId: GatewayProviderAccountBindingIdSchema,
  evidence: ProviderEvidenceSchema,
  evidenceId: ProviderEvidenceIdSchema,
  notificationId: Schema.Option(ProviderNotificationIdSchema),
  operationId: PaymentOperationIdSchema,
  origin: ProviderEvidenceOriginSchema,
  paymentId: PaymentIdSchema,
  receivedAt: Schema.DateTimeUtc,
  recordedAt: Schema.DateTimeUtc,
  /**
   * The principal that executes the governed A8 submission of this row. Pinned once while the row is pending
   * and never changed, so every later attempt asks Shell for exactly that executor. Absent until pinned.
   */
  submissionExecutorPrincipalId: Schema.optional(PaymentPrincipalIdSchema),
  submissionState: ProviderEvidenceSubmissionStateSchema,
  verifiedAt: Schema.DateTimeUtc,
});
export type StoredProviderEvidence = typeof StoredProviderEvidenceSchema.Type;

export interface AppendProviderEvidenceInput {
  readonly bindingId: typeof GatewayProviderAccountBindingIdSchema.Type;
  readonly evidence: typeof ProviderEvidenceSchema.Type;
  /** The captured notification this evidence was obtained for; it must belong to `bindingId`. */
  readonly notificationId: Option.Option<typeof ProviderNotificationIdSchema.Type>;
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

export interface PinProviderEvidenceSubmissionExecutorInput {
  readonly evidenceId: ProviderEvidenceId;
  /** The receiving principal Shell attested for this submission. */
  readonly principalId: string;
  readonly scope: OutboxWorkerLegalEntityScope;
}

export interface ProviderEvidenceStoreContract {
  /**
   * Keyed on (binding, sourceOccurrenceId, sourceRevision). An identical statement for the same operation
   * returns the existing row (its first receipt instants and notification are kept). The same key with a
   * different operation or a different statement fails with `GatewayEvidenceConflict`; nothing is written.
   */
  readonly append: (
    input: AppendProviderEvidenceInput,
  ) => Effect.Effect<StoredProviderEvidence, GatewayEvidenceConflictError | GatewayLedgerUnavailableError>;
  /** Oldest first. */
  readonly listPending: (
    input: ListPendingProviderEvidenceInput,
  ) => Effect.Effect<readonly StoredProviderEvidence[], GatewayLedgerUnavailableError>;
  /** Idempotent for the same outcome; a different terminal outcome for a settled row fails. */
  readonly markSubmission: (
    input: MarkProviderEvidenceSubmissionInput,
  ) => Effect.Effect<StoredProviderEvidence, GatewayLedgerUnavailableError>;
  /**
   * Pins the submission executor of a pending row once; the same principal again returns the row unchanged.
   * Another principal, or a row that is no longer pending without one, fails with `GatewayEvidenceConflict`.
   */
  readonly pinSubmissionExecutor: (
    input: PinProviderEvidenceSubmissionExecutorInput,
  ) => Effect.Effect<StoredProviderEvidence, GatewayEvidenceConflictError | GatewayLedgerUnavailableError>;
}

export class ProviderEvidenceStore extends Context.Service<ProviderEvidenceStore, ProviderEvidenceStoreContract>()(
  '@app/payment/integrations/psp/evidence-store/ProviderEvidenceStore',
) {}
