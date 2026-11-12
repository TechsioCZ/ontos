import { Effect, Layer, Match, Option, Schema } from 'effect';

import {
  PspNotificationIdSchema,
  pspAppendEvidence,
  pspListPendingEvidence,
  pspMarkEvidenceSubmission,
} from '../../persistence/psp-worker-routines.ts';
import type { PspEvidenceRecord } from '../../persistence/psp-worker-routines.ts';
import { ledgerUnavailable, routineUnavailable, workerOriginOf } from './dispatch-ledger-live.ts';
import { ProviderEvidenceStore, StoredProviderEvidenceSchema } from './evidence-store.ts';
import type {
  AppendProviderEvidenceInput,
  ListPendingProviderEvidenceInput,
  MarkProviderEvidenceSubmissionInput,
  ProviderEvidenceStoreContract,
} from './evidence-store.ts';
import { GatewayEvidenceConflict } from './psp-errors.ts';
import { ProviderAmountDiscrepancySchema } from './psp-money.ts';
import { ProviderObjectRefSchema } from './psp-request.ts';

/**
 * Worker-side C17 provider evidence over the W1-DB scoped routines (#1158, plan D8). Evidence is appended
 * PENDING_SUBMISSION and moves once to a terminal submission outcome. The ledger, not the caller, sets the
 * stored instants: `receivedAt` from the linked notification of the same binding (else `observedAt`) and
 * `verifiedAt` from `observedAt`.
 */

/** The routine's evidence identity, with the same brand as the frozen wrapper's `PspEvidenceId`. */
const PspEvidenceIdSchema = Schema.String.check(Schema.isUUID()).pipe(Schema.brand('PspEvidenceId'));

const ProviderRefsSchema = Schema.Array(ProviderObjectRefSchema);

const encodingFailed = (failure: Schema.SchemaError) => ledgerUnavailable(`evidence_encoding_failed: ${failure._tag}`);

/** The adapter's evidence as the routine stores it (provider refs and discrepancy as JSON documents). */
const encodedDocuments = (input: AppendProviderEvidenceInput) =>
  Effect.all(
    [
      Schema.encodeEffect(ProviderRefsSchema)(input.evidence.providerRefs),
      Option.match(input.evidence.discrepancy, {
        onNone: () => Effect.succeedNone,
        onSome: (discrepancy) =>
          Schema.encodeEffect(ProviderAmountDiscrepancySchema)(discrepancy).pipe(Effect.map(Option.some)),
      }),
      Option.match(input.notificationId, {
        onNone: () => Effect.succeedNone,
        onSome: (notificationId) =>
          Schema.decodeUnknownEffect(PspNotificationIdSchema)(notificationId).pipe(Effect.map(Option.some)),
      }),
    ],
    { concurrency: 1 },
  ).pipe(Effect.mapError(encodingFailed));

/** The stored statement read back as the provider-neutral evidence it was appended from. */
const storedEvidenceOf = Effect.fn('ProviderEvidenceStore.storedOf')(function* storedEvidenceOf(
  row: PspEvidenceRecord,
) {
  const [providerRefs, discrepancy] = yield* Effect.all(
    [
      Schema.decodeUnknownEffect(ProviderRefsSchema)(row.providerRefs),
      row.discrepancy === undefined
        ? Effect.succeedNone
        : Schema.decodeUnknownEffect(ProviderAmountDiscrepancySchema)(row.discrepancy).pipe(Effect.map(Option.some)),
    ],
    { concurrency: 1 },
  ).pipe(Effect.mapError((failure) => ledgerUnavailable(`evidence_record_invalid: ${failure._tag}`)));
  return yield* Schema.decodeUnknownEffect(StoredProviderEvidenceSchema)({
    bindingId: row.bindingId,
    evidence: {
      discrepancy,
      economicEffectKey: Option.fromUndefinedOr(row.economicEffectKey),
      factFamily: row.factFamily,
      factKind: row.factKind,
      observedAmount:
        row.observedAmountMinor === undefined || row.observedCurrency === undefined
          ? Option.none()
          : Option.some({ amountMinor: row.observedAmountMinor, currency: row.observedCurrency }),
      // `verifiedAt` is exactly the observation instant the evidence was appended with.
      observedAt: row.verifiedAt,
      providerOccurredAt: Option.fromUndefinedOr(row.providerOccurredAt),
      providerRefs,
      reason: Option.fromUndefinedOr(row.reason),
      sourceOccurrenceId: row.sourceOccurrenceId,
      sourceRevision: row.sourceRevision,
    },
    evidenceId: row.evidenceId,
    notificationId: Option.fromUndefinedOr(row.notificationId),
    operationId: row.operationId,
    origin: row.evidenceOrigin,
    paymentId: row.paymentId,
    receivedAt: row.receivedAt,
    recordedAt: row.recordedAt,
    submissionState: row.submissionState,
    verifiedAt: row.verifiedAt,
  }).pipe(Effect.mapError((failure) => ledgerUnavailable(`evidence_record_invalid: ${failure._tag}`)));
});

const evidenceConflict = (reason: string) =>
  new GatewayEvidenceConflict({
    code: 'gateway_evidence_conflict',
    reason: `The provider evidence was refused: ${reason}`,
  });

const append = Effect.fn('ProviderEvidenceStore.append')(function* append(input: AppendProviderEvidenceInput) {
  const [origin, [providerRefs, discrepancy, notificationId]] = yield* Effect.all(
    [workerOriginOf(input.workerContext), encodedDocuments(input)],
    { concurrency: 1 },
  );
  const { evidence } = input;
  const result = yield* pspAppendEvidence(input.scope.routineInvoker, {
    bindingId: input.bindingId,
    discrepancy,
    economicEffectKey: evidence.economicEffectKey,
    evidenceOrigin: input.origin,
    factFamily: evidence.factFamily,
    factKind: evidence.factKind,
    notificationId,
    observedAmount: evidence.observedAmount,
    observedAt: evidence.observedAt,
    operationId: input.operationId,
    origin,
    providerOccurredAt: evidence.providerOccurredAt,
    providerRefs,
    reason: evidence.reason,
    sourceOccurrenceId: evidence.sourceOccurrenceId,
    sourceRevision: evidence.sourceRevision,
  }).pipe(Effect.mapError(routineUnavailable));
  const row = yield* Match.valueTags(result, {
    APPENDED: ({ record }) => Effect.succeed(record),
    CONFLICT: ({ reason }) => Effect.fail(evidenceConflict(reason)),
    EXISTING: ({ record }) => Effect.succeed(record),
  });
  // The routine takes the Payment from the operation; a caller naming another Payment is refused.
  if (row.paymentId !== input.paymentId) {
    return yield* evidenceConflict('payment_mismatch');
  }
  return yield* storedEvidenceOf(row);
});

const listPending = Effect.fn('ProviderEvidenceStore.listPending')(function* listPending(
  input: ListPendingProviderEvidenceInput,
) {
  const rows = yield* pspListPendingEvidence(input.scope.routineInvoker, input.operationId).pipe(
    Effect.mapError(routineUnavailable),
  );
  return yield* Effect.forEach(rows, storedEvidenceOf, { concurrency: 1 });
});

const evidenceIdOf = (input: MarkProviderEvidenceSubmissionInput) =>
  Schema.decodeUnknownEffect(PspEvidenceIdSchema)(input.evidenceId).pipe(
    Effect.mapError((failure) => ledgerUnavailable(`evidence_id_invalid: ${failure._tag}`)),
  );

const markSubmission = Effect.fn('ProviderEvidenceStore.markSubmission')(function* markSubmission(
  input: MarkProviderEvidenceSubmissionInput,
) {
  const evidenceId = yield* evidenceIdOf(input);
  const result = yield* pspMarkEvidenceSubmission(input.scope.routineInvoker, {
    deliveryId: input.workerContext.deliveryId,
    evidenceId,
    observationId: input.observationId,
    state: input.outcome,
  }).pipe(Effect.mapError(routineUnavailable));
  const row = yield* Match.valueTags(result, {
    CONFLICT: ({ reason }) => Effect.fail(ledgerUnavailable(`evidence_submission_refused: ${reason}`)),
    MARKED: ({ record }) => Effect.succeed(record),
    NOT_FOUND: () => Effect.fail(ledgerUnavailable('evidence_submission_refused: evidence_unknown')),
    UNCHANGED: ({ record }) => Effect.succeed(record),
  });
  return yield* storedEvidenceOf(row);
});

const providerEvidenceStore: ProviderEvidenceStoreContract = Object.freeze({ append, listPending, markSubmission });

/** The store needs no service of its own: each call carries the verified worker scope. */
export const ProviderEvidenceStoreLive = Layer.succeed(ProviderEvidenceStore, providerEvidenceStore);
