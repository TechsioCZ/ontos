import type { ScopedRoutineInvocationError, ScopedRoutineInvoker } from '@app/core-runtime';
import type { OutboxWorkerHandlerContext, OutboxWorkerLegalEntityScope } from '@app/core-runtime/outbox/worker';
import { Effect, Layer, Match, Option, Schema } from 'effect';

import {
  pspCorrelateUnknownDispatch,
  pspHasUnresolvedRefund,
  pspPrepareDispatch,
  pspReadDispatch,
  pspReadDispatchByOrderReference,
  pspReadDispatchByProviderRef,
  pspRecordDispatchOutcome,
  pspRecordNotSent,
  pspRecordUnsupported,
  pspRegisterCancel,
  pspResolveNotificationBinding,
  pspWorkerOriginOf,
} from '../../persistence/psp-worker-routines.ts';
import type {
  PspDispatchChangeResult,
  PspDispatchRecord,
  PspRecordDispatchOutcomeInput,
  PspWorkerOrigin,
} from '../../persistence/psp-worker-routines.ts';
import { idempotencyKeyHashOf, ProviderDispatchLedger, ProviderDispatchRecordSchema } from './dispatch-ledger.ts';
import type {
  CorrelateUnknownInput,
  PrepareDispatchInput,
  ProviderDispatchIdentity,
  ProviderDispatchLedgerContract,
  ProviderPrepareResult,
  ReadByOperationInput,
  ReadByOrderReferenceInput,
  ReadByProviderRefInput,
  RecordAcknowledgedInput,
  RecordNotSentInput,
  RecordTransitionInput,
  RecordUnsupportedInput,
  RefundSerialization,
  RefundSerializationInput,
  RegisterCancelInput,
} from './dispatch-ledger.ts';
import { GatewayCorrelationConflict, GatewayLedgerUnavailable } from './psp-errors.ts';
import type { GatewayLedgerUnavailableError } from './psp-errors.ts';
import { ProviderObjectRefSchema } from './psp-request.ts';
import type { ProviderObjectRef } from './psp-request.ts';

/**
 * Worker-side provider dispatch ledger over the W1-DB scoped routines (#1156, #1158). Workers hold no
 * database executor: every call goes through the routine invoker of the Core-verified legal-entity scope,
 * and every write carries the delivery's origin (fail closed when the delivery has no originating Action).
 *
 * Provider object references are stored as `<ProviderObjectRef tag>:<provider id>` text, so a read rebuilds
 * the exact typed reference and a lookup by reference never infers the object kind from an id prefix.
 */

export const ledgerUnavailable = (reason: string): GatewayLedgerUnavailableError =>
  new GatewayLedgerUnavailable({ code: 'gateway_ledger_unavailable', reason: reason.slice(0, 500) });

/** A routine failure (scope mismatch, guard violation, transport, invalid result) is retryable unavailability. */
export const routineUnavailable = (failure: ScopedRoutineInvocationError): GatewayLedgerUnavailableError =>
  ledgerUnavailable(`${failure.routineKey} failed: ${failure.code}`);

/** The origin columns of a worker write; a delivery without an originating Action invocation writes nothing. */
export const workerOriginOf = (context: OutboxWorkerHandlerContext) =>
  Option.match(pspWorkerOriginOf(context), {
    onNone: () =>
      Effect.fail(ledgerUnavailable('worker_origin_missing: the delivery has no originating Action invocation')),
    onSome: (origin) => Effect.succeed<PspWorkerOrigin>(origin),
  });

const invokerOf = (scope: OutboxWorkerLegalEntityScope): ScopedRoutineInvoker => scope.routineInvoker;

/** Persisted text form of a provider object reference. */
export const providerRefText = (ref: ProviderObjectRef): string =>
  `${ref._tag}:${Match.valueTags(ref, {
    COMGATE_TRANSACTION: ({ transId }) => transId,
    GOPAY_PAYMENT: ({ id }) => id,
    STRIPE_CHECKOUT_SESSION: ({ id }) => id,
    STRIPE_PAYMENT_INTENT: ({ id }) => id,
    STRIPE_REFUND: ({ id }) => id,
  })}`;

const COMGATE_TRANSACTION_TAG = 'COMGATE_TRANSACTION';

/** The typed reference of a persisted text; `None` for any text this ledger did not write. */
export const providerRefOfText = (text: string): Option.Option<ProviderObjectRef> => {
  const separator = text.indexOf(':');
  if (separator <= 0) {
    return Option.none();
  }
  const tag = text.slice(0, separator);
  const id = text.slice(separator + 1);
  return Schema.decodeUnknownOption(ProviderObjectRefSchema)(
    tag === COMGATE_TRANSACTION_TAG ? { _tag: tag, transId: id } : { _tag: tag, id },
  );
};

const storedRefOf = (text: string | undefined, column: string) =>
  text === undefined
    ? Effect.succeedNone
    : Option.match(providerRefOfText(text), {
        onNone: () => Effect.fail(ledgerUnavailable(`dispatch_record_invalid: unreadable ${column}`)),
        onSome: (ref) => Effect.succeedSome(ref),
      });

/**
 * The credential revision of a row. Rows that were never prepared (AWAITING_TARGET, NOT_SENT, UNSUPPORTED)
 * record none; they report the binding's current ACTIVE revision, the only one any later request of the
 * same binding may use (plan §13). The resolved binding must be exactly the row's binding.
 */
const credentialRevisionOf = (scope: OutboxWorkerLegalEntityScope, row: PspDispatchRecord) =>
  row.credentialRevision === undefined
    ? pspResolveNotificationBinding(invokerOf(scope), {
        environment: row.environment,
        providerAccountRef: row.providerAccountRef,
      }).pipe(
        Effect.mapError(routineUnavailable),
        Effect.flatMap((target) =>
          Option.isSome(target) && target.value.bindingId === row.bindingId
            ? Effect.succeed(target.value.credentialRevision)
            : Effect.fail(ledgerUnavailable('dispatch_binding_unresolved: the dispatch binding has no credential')),
        ),
      )
    : Effect.succeed(row.credentialRevision);

const decodeRecord = Schema.decodeUnknownEffect(ProviderDispatchRecordSchema);

/** The typed ledger record of one routine row. */
const dispatchRecordOf = Effect.fn('ProviderDispatchLedger.recordOf')(function* dispatchRecordOf(
  scope: OutboxWorkerLegalEntityScope,
  row: PspDispatchRecord,
) {
  const [providerPaymentRef, providerRefundRef, credentialRevision] = yield* Effect.all(
    [
      storedRefOf(row.providerPaymentRef, 'provider_payment_ref'),
      storedRefOf(row.providerRefundRef, 'provider_refund_ref'),
      credentialRevisionOf(scope, row),
    ],
    { concurrency: 1 },
  );
  return yield* decodeRecord({
    bindingId: row.bindingId,
    credentialRevision,
    customerRedirectUrl: Option.fromUndefinedOr(row.customerRedirectUrl),
    endpointRef: Option.fromUndefinedOr(row.endpointRef),
    environment: row.environment,
    idempotencyKeyHash: Option.fromUndefinedOr(row.idempotencyKeyHash),
    materialHash: row.materialHash,
    notSentReason: Option.fromUndefinedOr(row.notSentReason),
    operationId: row.operationId,
    operationKind: row.operationKind,
    orderReference: row.orderReference,
    paymentId: row.paymentId,
    preparedAt: Option.fromUndefinedOr(row.preparedAt),
    providerAccountRef: row.providerAccountRef,
    providerFamily: row.providerFamily,
    providerPaymentRef,
    providerRefundRef,
    refundBaseline: Option.fromUndefinedOr(row.providerRefundBaseline).pipe(Option.map((rowIds) => ({ rowIds }))),
    replayExpiresAt: Option.fromUndefinedOr(row.replayExpiresAt),
    replayStartsAt: Option.fromUndefinedOr(row.replayStartsAt),
    requestBody: Option.fromUndefinedOr(row.requestBody),
    requestHash: Option.fromUndefinedOr(row.requestHash),
    requestHeaders: Option.fromUndefinedOr(row.requestHeaders),
    respondedAt: Option.fromUndefinedOr(row.respondedAt),
    returnToken: Option.fromUndefinedOr(row.returnToken),
    state: row.state,
    targetOperationId: Option.fromUndefinedOr(row.targetOperationId),
  }).pipe(Effect.mapError((failure) => ledgerUnavailable(`dispatch_record_invalid: ${failure._tag}`)));
});

const optionalRecordOf = (scope: OutboxWorkerLegalEntityScope, row: Option.Option<PspDispatchRecord>) =>
  Option.match(row, {
    onNone: () => Effect.succeedNone,
    onSome: (value) => dispatchRecordOf(scope, value).pipe(Effect.map(Option.some)),
  });

const readRow = (scope: OutboxWorkerLegalEntityScope, operationId: string) =>
  pspReadDispatch(invokerOf(scope), operationId).pipe(Effect.mapError(routineUnavailable));

const identityOf = (identity: ProviderDispatchIdentity) => ({
  bindingId: identity.target.bindingId,
  materialHash: identity.materialHash,
  operationId: identity.operationId,
});

/** The acknowledged provider payment a CANCEL or REFUND acts on, as persisted on its target's row. */
const targetPaymentRefOf = (scope: OutboxWorkerLegalEntityScope, identity: ProviderDispatchIdentity) =>
  Option.match(identity.targetOperationId, {
    onNone: () => Effect.succeedNone,
    onSome: (targetOperationId) =>
      readRow(scope, targetOperationId).pipe(
        Effect.map(Option.flatMap((target) => Option.fromUndefinedOr(target.providerPaymentRef))),
      ),
  });

/** A refused change (NOT_FOUND or CONFLICT) is not retryable success; the ledger reports it fail-closed. */
const changeRefused = (routine: string, reason: string) => ledgerUnavailable(`${routine} refused: ${reason}`);

const prepare = Effect.fn('ProviderDispatchLedger.prepare')(function* prepare(input: PrepareDispatchInput) {
  const [origin, providerPaymentRef] = yield* Effect.all(
    [workerOriginOf(input.workerContext), targetPaymentRefOf(input.scope, input.identity)],
    { concurrency: 1 },
  );
  const { prepared } = input;
  const result = yield* pspPrepareDispatch(invokerOf(input.scope), {
    ...identityOf(input.identity),
    credentialRevision: input.identity.target.credentialRevision,
    endpointRef: prepared.endpointRef,
    idempotencyKeyHash: prepared.idempotencyKey.pipe(Option.map(idempotencyKeyHashOf)),
    origin,
    providerPaymentRef,
    refundBaseline: prepared.refundBaseline.pipe(Option.map(({ rowIds }) => rowIds)),
    refundDispatchCount: input.refundDispatchCount,
    replayRequest: prepared.replayWindowMs.pipe(
      Option.map((windowMs) => ({ body: prepared.body, headers: prepared.headers, windowMs })),
    ),
    requestHash: prepared.requestHash,
    returnToken: input.returnToken,
  }).pipe(Effect.mapError(routineUnavailable));
  return yield* Match.valueTags(result, {
    CONFLICT: ({ reason, record }) =>
      // A refusal decided before the row was read carries no row; report the row that exists, if any.
      (record === undefined ? readRow(input.scope, input.identity.operationId) : Effect.succeedSome(record)).pipe(
        Effect.flatMap(
          Option.match({
            onNone: () => Effect.fail(changeRefused('psp_prepare_dispatch', reason)),
            onSome: (existing) =>
              dispatchRecordOf(input.scope, existing).pipe(
                Effect.map((stored): ProviderPrepareResult => ({ _tag: 'CONFLICT', existing: stored })),
              ),
          }),
        ),
      ),
    DEFERRED: ({ unresolvedRefundOperationIds }) =>
      Effect.succeed<ProviderPrepareResult>({ _tag: 'DEFERRED', unresolvedRefundOperationIds }),
    EXISTING: ({ record }) =>
      dispatchRecordOf(input.scope, record).pipe(
        Effect.map((stored): ProviderPrepareResult => ({ _tag: 'EXISTING', record: stored })),
      ),
    PREPARED: ({ record }) =>
      dispatchRecordOf(input.scope, record).pipe(
        Effect.map((stored): ProviderPrepareResult => ({ _tag: 'PREPARED', record: stored })),
      ),
    REFUND_BASELINE_STALE: () => Effect.succeed<ProviderPrepareResult>({ _tag: 'REFUND_BASELINE_STALE' }),
    WITHHELD: ({ record }) =>
      dispatchRecordOf(input.scope, record).pipe(
        Effect.map((stored): ProviderPrepareResult => ({ _tag: 'WITHHELD', record: stored })),
      ),
  });
});

const registerCancel = Effect.fn('ProviderDispatchLedger.registerCancel')(function* registerCancel(
  input: RegisterCancelInput,
) {
  const origin = yield* workerOriginOf(input.workerContext);
  const result = yield* pspRegisterCancel(invokerOf(input.scope), { ...identityOf(input.cancel), origin }).pipe(
    Effect.mapError(routineUnavailable),
  );
  const registered = yield* Match.valueTags(result, {
    CONFLICT: ({ reason }) => Effect.fail(changeRefused('psp_register_cancel', reason)),
    EXISTING: ({ cancel, target }) => Effect.succeed({ cancel, target }),
    REGISTERED: ({ cancel, target }) => Effect.succeed({ cancel, target }),
  });
  const [cancel, target] = yield* Effect.all(
    [
      dispatchRecordOf(input.scope, registered.cancel),
      optionalRecordOf(input.scope, Option.fromUndefinedOr(registered.target)),
    ],
    { concurrency: 1 },
  );
  return { cancel, target };
});

/** The routine stamps `responded_at` with its own transaction time; the caller's instant is not persisted. */
const recordOutcome = (
  input: RecordTransitionInput | RecordAcknowledgedInput,
  to: PspRecordDispatchOutcomeInput['to'],
  refs: {
    readonly customerRedirectUrl: Option.Option<string>;
    readonly providerPaymentRef: Option.Option<ProviderObjectRef>;
    readonly providerRefundRef: Option.Option<ProviderObjectRef>;
  },
) =>
  pspRecordDispatchOutcome(invokerOf(input.scope), {
    customerRedirectUrl: refs.customerRedirectUrl,
    deliveryId: input.workerContext.deliveryId,
    operationId: input.operationId,
    providerPaymentRef: refs.providerPaymentRef.pipe(Option.map(providerRefText)),
    providerRefundRef: refs.providerRefundRef.pipe(Option.map(providerRefText)),
    to,
  }).pipe(
    Effect.mapError(routineUnavailable),
    Effect.flatMap((result) =>
      Match.valueTags(result, {
        CONFLICT: ({ reason }) => Effect.fail(changeRefused('psp_record_dispatch_outcome', reason)),
        NOT_FOUND: () => Effect.fail(changeRefused('psp_record_dispatch_outcome', 'operation_not_dispatched')),
        RECORDED: ({ record }) => dispatchRecordOf(input.scope, record),
        UNCHANGED: ({ record }) => dispatchRecordOf(input.scope, record),
      }),
    ),
  );

const NO_REFS = {
  customerRedirectUrl: Option.none(),
  providerPaymentRef: Option.none(),
  providerRefundRef: Option.none(),
} as const;

const recordAcknowledged = Effect.fn('ProviderDispatchLedger.recordAcknowledged')(function* recordAcknowledged(
  input: RecordAcknowledgedInput,
) {
  return yield* recordOutcome(input, 'ACKNOWLEDGED', input);
});
const recordOutcomeUnknown = Effect.fn('ProviderDispatchLedger.recordOutcomeUnknown')(function* recordOutcomeUnknown(
  input: RecordTransitionInput,
) {
  return yield* recordOutcome(input, 'OUTCOME_UNKNOWN', NO_REFS);
});
const recordRejected = Effect.fn('ProviderDispatchLedger.recordRejected')(function* recordRejected(
  input: RecordTransitionInput,
) {
  return yield* recordOutcome(input, 'REJECTED_BEFORE_EFFECT', NO_REFS);
});
const recordTargetUnresolved = Effect.fn('ProviderDispatchLedger.recordTargetUnresolved')(
  function* recordTargetUnresolved(input: RecordTransitionInput) {
    return yield* recordOutcome(input, 'TARGET_UNRESOLVED', NO_REFS);
  },
);

const unsentRecord = (scope: OutboxWorkerLegalEntityScope, routine: string) =>
  Effect.flatMap((result: PspDispatchChangeResult) =>
    Match.valueTags(result, {
      CONFLICT: ({ reason }) => Effect.fail(changeRefused(routine, reason)),
      NOT_FOUND: () => Effect.fail(changeRefused(routine, 'operation_unknown')),
      RECORDED: ({ record }) => dispatchRecordOf(scope, record),
      UNCHANGED: ({ record }) => dispatchRecordOf(scope, record),
    }),
  );

const recordNotSent = Effect.fn('ProviderDispatchLedger.recordNotSent')(function* recordNotSent(
  input: RecordNotSentInput,
) {
  const origin = yield* workerOriginOf(input.workerContext);
  return yield* pspRecordNotSent(invokerOf(input.scope), {
    ...identityOf(input.identity),
    origin,
    reason: input.reason,
  }).pipe(Effect.mapError(routineUnavailable), unsentRecord(input.scope, 'psp_record_not_sent'));
});

const recordUnsupported = Effect.fn('ProviderDispatchLedger.recordUnsupported')(function* recordUnsupported(
  input: RecordUnsupportedInput,
) {
  const origin = yield* workerOriginOf(input.workerContext);
  return yield* pspRecordUnsupported(invokerOf(input.scope), { ...identityOf(input.identity), origin }).pipe(
    Effect.mapError(routineUnavailable),
    unsentRecord(input.scope, 'psp_record_unsupported'),
  );
});

/** A Stripe refund object is the refund's own reference; every other object is the provider payment. */
const isRefundObject = (ref: ProviderObjectRef): boolean =>
  Match.valueTags(ref, {
    COMGATE_TRANSACTION: () => false,
    GOPAY_PAYMENT: () => false,
    STRIPE_CHECKOUT_SESSION: () => false,
    STRIPE_PAYMENT_INTENT: () => false,
    STRIPE_REFUND: () => true,
  });

const correlateUnknown = Effect.fn('ProviderDispatchLedger.correlateUnknown')(function* correlateUnknown(
  input: CorrelateUnknownInput,
) {
  const refText = Option.some(providerRefText(input.providerRef));
  const refund = isRefundObject(input.providerRef);
  const result = yield* pspCorrelateUnknownDispatch(invokerOf(input.scope), {
    bindingId: input.bindingId,
    deliveryId: input.workerContext.deliveryId,
    orderReference: input.orderReference,
    providerPaymentRef: refund ? Option.none() : refText,
    providerRefundRef: refund ? refText : Option.none(),
  }).pipe(Effect.mapError(routineUnavailable));
  return yield* Match.valueTags(result, {
    ALREADY_CORRELATED: ({ record }) => dispatchRecordOf(input.scope, record).pipe(Effect.map(Option.some)),
    CONFLICT: ({ reason }) =>
      Effect.fail(
        new GatewayCorrelationConflict({
          code: 'gateway_correlation_conflict',
          reason: `The order reference names a dispatch with another provider reference or state: ${reason}`,
        }),
      ),
    CORRELATED: ({ record }) => dispatchRecordOf(input.scope, record).pipe(Effect.map(Option.some)),
    NOT_FOUND: () => Effect.succeedNone,
  });
});

const readByOperation = Effect.fn('ProviderDispatchLedger.readByOperation')(function* readByOperation(
  input: ReadByOperationInput,
) {
  return yield* optionalRecordOf(input.scope, yield* readRow(input.scope, input.operationId));
});

const readByOrderReference = Effect.fn('ProviderDispatchLedger.readByOrderReference')(function* readByOrderReference(
  input: ReadByOrderReferenceInput,
) {
  const row = yield* pspReadDispatchByOrderReference(invokerOf(input.scope), {
    bindingId: input.bindingId,
    orderReference: input.orderReference,
  }).pipe(Effect.mapError(routineUnavailable));
  return yield* optionalRecordOf(input.scope, row);
});

/**
 * The dispatch a provider object belongs to inside one binding. A refund object names the REFUND row that
 * recorded it; a payment object names the COLLECT row that recorded it (CANCEL and REFUND rows carry their
 * target's payment reference too and are never returned for it). More than one owner fails closed.
 */
const readByProviderRef = Effect.fn('ProviderDispatchLedger.readByProviderRef')(function* readByProviderRef(
  input: ReadByProviderRefInput,
) {
  const refText = providerRefText(input.providerRef);
  const refund = isRefundObject(input.providerRef);
  const rows = yield* pspReadDispatchByProviderRef(invokerOf(input.scope), {
    bindingId: input.bindingId,
    providerRef: refText,
  }).pipe(Effect.mapError(routineUnavailable));
  const owners = rows.filter((row) =>
    refund ? row.providerRefundRef === refText : row.providerPaymentRef === refText && row.operationKind === 'COLLECT',
  );
  if (owners.length > 1) {
    return yield* Effect.fail(
      ledgerUnavailable('provider_ref_ambiguous: more than one dispatch records this provider object'),
    );
  }
  return yield* optionalRecordOf(input.scope, Option.fromUndefinedOr(owners[0]));
});

const refundSerialization = Effect.fn('ProviderDispatchLedger.refundSerialization')(function* refundSerialization(
  input: RefundSerializationInput,
) {
  const { refundDispatchCount, unresolved } = yield* pspHasUnresolvedRefund(invokerOf(input.scope), {
    bindingId: input.bindingId,
    excludingOperationId: Option.none(),
    providerPaymentRef: providerRefText(input.providerPaymentRef),
  }).pipe(Effect.mapError(routineUnavailable));
  return { refundDispatchCount, unresolved } satisfies RefundSerialization;
});

const providerDispatchLedger: ProviderDispatchLedgerContract = Object.freeze({
  correlateUnknown,
  prepare,
  readByOperation,
  readByOrderReference,
  readByProviderRef,
  recordAcknowledged,
  recordNotSent,
  recordOutcomeUnknown,
  recordRejected,
  recordTargetUnresolved,
  recordUnsupported,
  refundSerialization,
  registerCancel,
});

/** The ledger needs no service of its own: each call carries the verified worker scope. */
export const ProviderDispatchLedgerLive = Layer.succeed(ProviderDispatchLedger, providerDispatchLedger);
