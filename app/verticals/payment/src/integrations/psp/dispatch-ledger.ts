import type { OutboxWorkerHandlerContext, OutboxWorkerLegalEntityScope } from '@app/core-runtime/outbox/worker';
import { sha256 } from '@noble/hashes/sha2.js';
import { utf8ToBytes } from '@noble/hashes/utils.js';
import { Context, DateTime, Option, Schema } from 'effect';
import type { Effect } from 'effect';
import { Hex } from 'effect/encoding';

import {
  PaymentEvidenceRefSchema,
  PaymentIdSchema,
  PaymentMaterialHashSchema,
  PaymentOperationIdSchema,
  PaymentProviderAccountRefSchema,
} from '../../../shared/domain/payment-identifiers.ts';
import {
  PaymentGatewayProviderFamilySchema,
  PaymentOperationKindSchema,
} from '../../../shared/domain/payment-vocabulary.ts';
import {
  GatewayHttpsUrlSchema,
  GatewayProviderAccountBindingIdSchema,
  GatewayReturnTokenSchema,
} from '../../../shared/domain/psp-configuration.ts';
import type { GatewayProviderAccountBindingId } from '../../../shared/domain/psp-configuration.ts';
import {
  GatewayEnvironmentSchema,
  ProviderDispatchStateSchema,
  ProviderNotSentReasonSchema,
} from '../../../shared/domain/psp-vocabulary.ts';
import type { ProviderNotSentReason } from '../../../shared/domain/psp-vocabulary.ts';
import { deriveProviderCorrelation, GatewayOrderReferenceSchema } from './psp-correlation.ts';
import type { GatewayIdempotencyKey, GatewayOrderReference } from './psp-correlation.ts';
import type { GatewayCorrelationConflictError, GatewayLedgerUnavailableError } from './psp-errors.ts';
import { ProviderObjectRefSchema } from './psp-request.ts';
import type { GatewayExecutionTarget, ProviderObjectRef } from './psp-request.ts';
import { ProviderReplayRequestSchema, ProviderRequestHeaderSchema } from './psp-result.ts';
import type { PreparedProviderRequest, ProviderReplayRequest } from './psp-result.ts';

/**
 * Worker-side provider dispatch ledger (#1156, #1158; plan §2.1, §3.4). One row per Payment
 * Operation. Every call goes through a SECURITY DEFINER scoped routine of the Core-verified worker
 * scope; workers hold no database executor. Writes carry the delivery's origin, never a human actor.
 *
 * Redelivery rule: the executor calls `readByOperation` before any adapter `prepare*`. When a prepared
 * row exists it never prepares again; it continues from the persisted row (a Stripe replay uses
 * `replayRequestOf(record)`), so a new return token or a new clock reading can never turn an honest
 * retry into a conflict. `prepare` is called only when no row exists or the row is an AWAITING_TARGET
 * cancel.
 */

type OperationId = typeof PaymentOperationIdSchema.Type;
type MaterialHash = typeof PaymentMaterialHashSchema.Type;
type LedgerFailure = GatewayLedgerUnavailableError;

const credentialRevisionSchema = Schema.Finite.check(Schema.isInt(), Schema.isGreaterThanOrEqualTo(1));

/** One persisted dispatch row as read back through a scoped routine. Holds no secret. */
export const ProviderDispatchRecordSchema = Schema.Struct({
  bindingId: GatewayProviderAccountBindingIdSchema,
  credentialRevision: credentialRevisionSchema,
  customerRedirectUrl: Schema.Option(GatewayHttpsUrlSchema),
  /** Absent only for AWAITING_TARGET, UNSUPPORTED and NOT_SENT rows that were never prepared. */
  endpointRef: Schema.Option(PaymentEvidenceRefSchema),
  environment: GatewayEnvironmentSchema,
  idempotencyKeyHash: Schema.Option(PaymentMaterialHashSchema),
  /** The C16 operation-requested `materialHash` (plan D13). */
  materialHash: PaymentMaterialHashSchema,
  notSentReason: Schema.Option(ProviderNotSentReasonSchema),
  operationId: PaymentOperationIdSchema,
  operationKind: PaymentOperationKindSchema,
  orderReference: GatewayOrderReferenceSchema,
  paymentId: PaymentIdSchema,
  preparedAt: Schema.Option(Schema.DateTimeUtc),
  providerAccountRef: PaymentProviderAccountRefSchema,
  providerFamily: PaymentGatewayProviderFamilySchema,
  /** Collection object: GoPay payment, Stripe session or payment intent, Comgate transaction. */
  providerPaymentRef: Schema.Option(ProviderObjectRefSchema),
  providerRefundRef: Schema.Option(ProviderObjectRefSchema),
  replayExpiresAt: Schema.Option(Schema.DateTimeUtc),
  replayStartsAt: Schema.Option(Schema.DateTimeUtc),
  /** Exact persisted request bytes and non-secret headers; present only with a replay window (Stripe). */
  requestBody: Schema.Option(Schema.Uint8Array),
  requestHash: Schema.Option(PaymentMaterialHashSchema),
  requestHeaders: Schema.Option(Schema.Array(ProviderRequestHeaderSchema)),
  respondedAt: Schema.Option(Schema.DateTimeUtc),
  returnToken: Schema.Option(GatewayReturnTokenSchema),
  state: ProviderDispatchStateSchema,
  targetOperationId: Schema.Option(PaymentOperationIdSchema),
});
export type ProviderDispatchRecord = typeof ProviderDispatchRecordSchema.Type;

/** Identity and material of the operation a row belongs to; immutable once inserted. */
export interface ProviderDispatchIdentity {
  readonly materialHash: MaterialHash;
  readonly operationId: OperationId;
  readonly operationKind: typeof PaymentOperationKindSchema.Type;
  readonly paymentId: typeof PaymentIdSchema.Type;
  readonly target: GatewayExecutionTarget;
  readonly targetOperationId: Option.Option<OperationId>;
}

/** Common to every ledger call: the verified scope, plus the delivery for origin columns on writes. */
interface LedgerScope {
  readonly scope: OutboxWorkerLegalEntityScope;
}
interface LedgerWrite extends LedgerScope {
  readonly workerContext: OutboxWorkerHandlerContext;
}

export interface RegisterCancelInput extends LedgerWrite {
  /** CANCEL_OR_VOID identity; `targetOperationId` is required for a cancel. */
  readonly cancel: ProviderDispatchIdentity;
}

/** The cancel row (inserted AWAITING_TARGET or existing) and the target's row, read under the same lock. */
export interface CancelRegistration {
  readonly cancel: ProviderDispatchRecord;
  readonly target: Option.Option<ProviderDispatchRecord>;
}

/**
 * The ledger stamps `preparedAt` with its own transaction time and, when `prepared.replayWindowMs` is
 * present, persists the exact body and headers with `replayStartsAt = preparedAt` and
 * `replayExpiresAt = preparedAt + replayWindowMs`.
 */
export interface PrepareDispatchInput extends LedgerWrite {
  readonly identity: ProviderDispatchIdentity;
  readonly prepared: PreparedProviderRequest;
  /** COLLECT only; generated before the commit so the return URL in `prepared` already carries it. */
  readonly returnToken: Option.Option<typeof GatewayReturnTokenSchema.Type>;
}

/**
 * PREPARED: committed now, safe to send. EXISTING: a row already exists with equal material and
 * request (a concurrent identical prepare). WITHHELD: a COLLECT targeted by a cancel, stored NOT_SENT.
 * DEFERRED: a GoPay or Comgate REFUND while another refund of the same provider payment is unresolved
 * (checked under the target's lock); nothing was written. CONFLICT: same operation, different material
 * or request; nothing may be sent.
 */
export const ProviderPrepareResultSchema = Schema.Union([
  Schema.TaggedStruct('PREPARED', { record: ProviderDispatchRecordSchema }),
  Schema.TaggedStruct('EXISTING', { record: ProviderDispatchRecordSchema }),
  Schema.TaggedStruct('WITHHELD', { record: ProviderDispatchRecordSchema }),
  Schema.TaggedStruct('DEFERRED', { unresolvedRefundOperationIds: Schema.Array(PaymentOperationIdSchema) }),
  Schema.TaggedStruct('CONFLICT', { existing: ProviderDispatchRecordSchema }),
]);
export type ProviderPrepareResult = typeof ProviderPrepareResultSchema.Type;

export interface RecordAcknowledgedInput extends LedgerWrite {
  readonly customerRedirectUrl: Option.Option<typeof GatewayHttpsUrlSchema.Type>;
  readonly operationId: OperationId;
  readonly providerPaymentRef: Option.Option<ProviderObjectRef>;
  readonly providerRefundRef: Option.Option<ProviderObjectRef>;
  readonly respondedAt: DateTime.Utc;
}

export interface RecordTransitionInput extends LedgerWrite {
  readonly at: DateTime.Utc;
  readonly operationId: OperationId;
}

export interface RecordUnsupportedInput extends LedgerWrite {
  readonly identity: ProviderDispatchIdentity;
}

export interface RecordNotSentInput extends LedgerWrite {
  /** Inserts the row when absent, or moves an AWAITING_TARGET row to NOT_SENT. */
  readonly identity: ProviderDispatchIdentity;
  readonly reason: ProviderNotSentReason;
}

export interface CorrelateUnknownInput extends LedgerWrite {
  readonly bindingId: GatewayProviderAccountBindingId;
  readonly orderReference: GatewayOrderReference;
  readonly providerRef: ProviderObjectRef;
}

export interface ReadByOperationInput extends LedgerScope {
  readonly operationId: OperationId;
}

export interface ReadByProviderRefInput extends LedgerScope {
  readonly bindingId: GatewayProviderAccountBindingId;
  readonly providerRef: ProviderObjectRef;
}

export interface ReadByOrderReferenceInput extends LedgerScope {
  readonly bindingId: GatewayProviderAccountBindingId;
  readonly orderReference: GatewayOrderReference;
}

export interface HasUnresolvedRefundInput extends LedgerScope {
  readonly bindingId: GatewayProviderAccountBindingId;
  readonly providerPaymentRef: ProviderObjectRef;
}

export interface ProviderDispatchLedgerContract {
  /**
   * OUTCOME_UNKNOWN → ACKNOWLEDGED with the provider ref, inside the exact binding. `None` when no
   * OUTCOME_UNKNOWN row has that order reference; a different existing ref is a correlation conflict.
   */
  readonly correlateUnknown: (
    input: CorrelateUnknownInput,
  ) => Effect.Effect<Option.Option<ProviderDispatchRecord>, GatewayCorrelationConflictError | LedgerFailure>;
  /**
   * True while another REFUND of this provider payment is unresolved: PREPARED, OUTCOME_UNKNOWN, or
   * ACKNOWLEDGED without REFUND_CONFIRMED or REFUND_NOT_EFFECTED evidence (GoPay and Comgate
   * serialization; `prepare` re-checks it under the target's lock and answers DEFERRED). A Comgate refund
   * stays unresolved until such evidence exists (completion is unprovable, plan N10).
   */
  readonly hasUnresolvedRefund: (input: HasUnresolvedRefundInput) => Effect.Effect<boolean, LedgerFailure>;
  readonly prepare: (input: PrepareDispatchInput) => Effect.Effect<ProviderPrepareResult, LedgerFailure>;
  readonly readByOperation: (
    input: ReadByOperationInput,
  ) => Effect.Effect<Option.Option<ProviderDispatchRecord>, LedgerFailure>;
  readonly readByOrderReference: (
    input: ReadByOrderReferenceInput,
  ) => Effect.Effect<Option.Option<ProviderDispatchRecord>, LedgerFailure>;
  readonly readByProviderRef: (
    input: ReadByProviderRefInput,
  ) => Effect.Effect<Option.Option<ProviderDispatchRecord>, LedgerFailure>;
  /** PREPARED or OUTCOME_UNKNOWN → ACKNOWLEDGED. */
  readonly recordAcknowledged: (input: RecordAcknowledgedInput) => Effect.Effect<ProviderDispatchRecord, LedgerFailure>;
  readonly recordNotSent: (input: RecordNotSentInput) => Effect.Effect<ProviderDispatchRecord, LedgerFailure>;
  /** PREPARED → OUTCOME_UNKNOWN. */
  readonly recordOutcomeUnknown: (input: RecordTransitionInput) => Effect.Effect<ProviderDispatchRecord, LedgerFailure>;
  /** PREPARED or OUTCOME_UNKNOWN → REJECTED_BEFORE_EFFECT. */
  readonly recordRejected: (input: RecordTransitionInput) => Effect.Effect<ProviderDispatchRecord, LedgerFailure>;
  /** AWAITING_TARGET → TARGET_UNRESOLVED after deferral exhaustion. */
  readonly recordTargetUnresolved: (
    input: RecordTransitionInput,
  ) => Effect.Effect<ProviderDispatchRecord, LedgerFailure>;
  /** Inserts an UNSUPPORTED row (e.g. GoPay cancel); nothing was or will be sent. */
  readonly recordUnsupported: (input: RecordUnsupportedInput) => Effect.Effect<ProviderDispatchRecord, LedgerFailure>;
  /** Inserts the cancel row AWAITING_TARGET under an advisory lock on the target operation id. */
  readonly registerCancel: (input: RegisterCancelInput) => Effect.Effect<CancelRegistration, LedgerFailure>;
}

export class ProviderDispatchLedger extends Context.Service<ProviderDispatchLedger, ProviderDispatchLedgerContract>()(
  '@app/payment/integrations/psp/dispatch-ledger/ProviderDispatchLedger',
) {}

/** SHA-256 hex of an idempotency key, the only form the ledger stores (`idempotencyKeyHash`). */
export const idempotencyKeyHashOf = (key: GatewayIdempotencyKey): typeof PaymentMaterialHashSchema.Type =>
  PaymentMaterialHashSchema.make(Hex.encode(sha256(utf8ToBytes(key))));

/**
 * The exact persisted request of a dispatch with a replay window, rebuilt for `adapter.replay`. The key
 * is re-derived from the operation id and must hash to the stored `idempotencyKeyHash`. `None` when the
 * row has no complete replayable request (GoPay, Comgate, unprepared rows) or the key does not match.
 */
export const replayRequestOf = (record: ProviderDispatchRecord): Option.Option<ProviderReplayRequest> => {
  const { idempotencyKey } = deriveProviderCorrelation(record.operationId);
  return Option.all({
    body: record.requestBody,
    endpointRef: record.endpointRef,
    expiresAt: record.replayExpiresAt,
    headers: record.requestHeaders,
    keyHash: record.idempotencyKeyHash,
    requestHash: record.requestHash,
    startsAt: record.replayStartsAt,
  }).pipe(
    Option.filter(({ keyHash }) => keyHash === idempotencyKeyHashOf(idempotencyKey)),
    Option.flatMap(({ body, endpointRef, expiresAt, headers, requestHash, startsAt }) =>
      Schema.decodeUnknownOption(ProviderReplayRequestSchema)({
        prepared: {
          body,
          endpointRef,
          family: record.providerFamily,
          headers,
          idempotencyKey: Option.some(idempotencyKey),
          orderReference: record.orderReference,
          replayWindowMs: Option.some(DateTime.toEpochMillis(expiresAt) - DateTime.toEpochMillis(startsAt)),
          requestHash,
        },
        window: { expiresAt, startsAt },
      }),
    ),
  );
};
