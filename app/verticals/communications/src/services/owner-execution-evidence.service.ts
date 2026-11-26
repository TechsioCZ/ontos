import type { ScopedTransactionExecutor } from '@app/core-runtime';
import { PrivacyDispatchContinuationPayloadSchema } from '@app/shared-contracts';
import type { PrivacyDispatchContinuationPayload } from '@app/shared-contracts';
import { Context, Effect, Match, Option, Schema } from 'effect';

import {
  OwnerExecutionEvidenceRejected,
  OwnerExecutionEvidenceStoreUnavailable,
} from '../../shared/owner-execution-evidence-errors.ts';
import type {
  OwnerExecutionEvidenceErrorSchema,
  OwnerExecutionEvidenceRefusalSchema,
} from '../../shared/owner-execution-evidence-errors.ts';
import type {
  RecordOwnerExecutionEvidencePayload,
  RecordOwnerExecutionEvidenceResult,
} from '../../shared/owner-execution-evidence.ts';
import {
  readPrivacyMeasureHandoffRoutine,
  recordPrivacyExecutionEvidenceRoutine,
} from '../persistence/communications-routines.ts';
import { HandoffDocumentSchema, RecordEvidenceAnswerSchema } from '../persistence/privacy-measure-records.ts';

const unavailable = (cause: unknown) =>
  Object.defineProperty(
    new OwnerExecutionEvidenceStoreUnavailable({
      code: 'owner_execution_evidence_store_unavailable',
      reason: 'The owner execution evidence is unavailable',
    }),
    'cause',
    { enumerable: false, value: cause },
  );
const refused = (refusal: typeof OwnerExecutionEvidenceRefusalSchema.Type, reason: string) =>
  new OwnerExecutionEvidenceRejected({ code: 'owner_execution_evidence_rejected', reason, refusal });

const settled = (
  payload: RecordOwnerExecutionEvidencePayload,
  outcome: RecordOwnerExecutionEvidenceResult['outcome'],
): RecordOwnerExecutionEvidenceResult => ({
  destructiveActionPerformed: false,
  evidenceRef: payload.evidenceRef,
  outcome,
});

const decodeDocument = Schema.decodeUnknownEffect(HandoffDocumentSchema);
type HandoffDocument = typeof HandoffDocumentSchema.Type;
type StoredEvidence = HandoffDocument['evidence'][number];

type EvidenceResults = StoredEvidence['results'] | RecordOwnerExecutionEvidencePayload['results'];

/** The same results, whatever their order: a record names every target at most once. */
const sameResults = (left: EvidenceResults, right: EvidenceResults): boolean =>
  left.length === right.length &&
  left.every((entry) =>
    right.some(
      (other) =>
        other.contentRef === entry.contentRef &&
        other.result === entry.result &&
        other.reconcilesEvidenceRef === entry.reconcilesEvidenceRef,
    ),
  );

/**
 * The same confirmation submitted again: the same evidence reference, phase, exact scope and results. WHO submitted it again
 * (a fresh Core idempotency key, so another invocation) does not make it different content: it is a clean no-op replay.
 */
const identicalRecord = (
  document: HandoffDocument,
  payload: RecordOwnerExecutionEvidencePayload,
  scopeDigest: string,
): boolean =>
  document.evidence.some(
    (stored) =>
      stored.evidenceRef === payload.evidenceRef &&
      stored.phase === payload.phase &&
      stored.scopeDigest === scopeDigest &&
      sameResults(stored.results, payload.results),
  );

/** A reconciliation names an EARLIER recorded possible-mutation failure of the very same target, and nothing else. */
const reconcilesRecordedFailures = (document: HandoffDocument, payload: RecordOwnerExecutionEvidencePayload): boolean =>
  payload.results.every(
    ({ contentRef, reconcilesEvidenceRef }) =>
      reconcilesEvidenceRef === undefined ||
      document.evidence.some(
        (stored) =>
          stored.evidenceRef === reconcilesEvidenceRef &&
          stored.results.some(
            (entry) => entry.contentRef === contentRef && entry.result === 'FAILED_AFTER_POSSIBLE_MUTATION',
          ),
      ),
  );

const decodeAnswer = Schema.decodeUnknownEffect(RecordEvidenceAnswerSchema);
const decodeContinuation = Schema.decodeUnknownEffect(PrivacyDispatchContinuationPayloadSchema);

const readDocument = (transaction: ScopedTransactionExecutor, idempotencyKey: string) =>
  transaction.invoke(readPrivacyMeasureHandoffRoutine, [idempotencyKey]).pipe(
    Effect.flatMap((rows) => decodeDocument(rows[0]?.result)),
    Effect.mapError(unavailable),
  );

/**
 * What one confirmation leaves behind: its public result and, only when THIS call stored new evidence, the continuation
 * that asks Privacy to read the next receipt attempt of the original dispatch. A replay or refusal continues nothing.
 */
export interface RecordedOwnerExecutionEvidence {
  readonly continuation: Option.Option<PrivacyDispatchContinuationPayload>;
  readonly result: RecordOwnerExecutionEvidenceResult;
}

export interface OwnerExecutionEvidenceService {
  readonly record: (
    payload: RecordOwnerExecutionEvidencePayload,
    confirmationInvocationId: string,
  ) => Effect.Effect<RecordedOwnerExecutionEvidence, typeof OwnerExecutionEvidenceErrorSchema.Type>;
}

const settledOnly = (result: RecordOwnerExecutionEvidenceResult): RecordedOwnerExecutionEvidence => ({
  continuation: Option.none(),
  result,
});

export class OwnerExecutionEvidence extends Context.Service<OwnerExecutionEvidence, OwnerExecutionEvidenceService>()(
  '@app/communications/services/owner-execution-evidence.service/OwnerExecutionEvidence',
) {}

/**
 * Records ONE human confirmation against the handoff the owner recorded. The exact scope is the stored one, never a caller's:
 * the confirmation must name the recorded handoff by its fingerprint and only its approved targets. The routine appends a row
 * and nothing else; this service performs no owner operation of any kind.
 */
export const ownerExecutionEvidenceFor = (transaction: ScopedTransactionExecutor): OwnerExecutionEvidenceService => ({
  record: Effect.fn('CommunicationsOwnerEvidence.record')(function* record(payload, confirmationInvocationId) {
    const document = yield* readDocument(transaction, payload.idempotencyKey);
    if (Option.isNone(document.record)) {
      return yield* refused('NO_HANDOFF_RECORDED_FOR_THIS_MEASURE', 'No handoff is recorded for this measure');
    }
    const stored = document.record.value;
    if (stored.handoffFingerprint !== payload.handoffFingerprint) {
      return yield* refused(
        'HANDOFF_FINGERPRINT_DOES_NOT_MATCH_THE_RECORDED_HANDOFF',
        'The confirmation names another handoff than the recorded one',
      );
    }
    const targets = new Set(stored.targetContentRefs);
    if (payload.results.some(({ contentRef }) => !targets.has(contentRef))) {
      return yield* refused(
        'RESULT_NAMES_CONTENT_OUTSIDE_THE_APPROVED_TARGETS',
        'A confirmed result names content that Privacy did not approve',
      );
    }
    if (identicalRecord(document, payload, stored.scopeDigest)) {
      return settledOnly(settled(payload, 'EXISTS'));
    }
    if (!reconcilesRecordedFailures(document, payload)) {
      return yield* refused(
        'RECONCILIATION_DOES_NOT_NAME_A_POSSIBLE_MUTATION_FAILURE_OF_THE_SAME_TARGET',
        'A reconciliation must name an earlier recorded possible-mutation failure of the same target',
      );
    }
    const answerRows = yield* transaction
      .invoke(recordPrivacyExecutionEvidenceRoutine, [
        payload.evidenceRef,
        payload.idempotencyKey,
        payload.phase,
        payload.results,
        stored.scopeDigest,
        confirmationInvocationId,
      ])
      .pipe(Effect.mapError(unavailable));
    const answer = yield* decodeAnswer(answerRows[0]?.result).pipe(Effect.mapError(unavailable));
    return yield* Match.value(answer.outcome).pipe(
      Match.when('RECORDED', (outcome) =>
        // The routine holds the handoff's lock to the end of this transaction, so the evidence count is exact: the
        // take-over report is attempt 1 and the n-th recorded confirmation asks Privacy for attempt n + 1.
        readDocument(transaction, payload.idempotencyKey).pipe(
          Effect.flatMap((current) =>
            decodeContinuation({
              attempt: current.evidence.length + 1,
              dispatchInvocationId: stored.originatorInvocationId,
              measureId: stored.measureId,
              taskId: stored.taskId,
            }).pipe(Effect.mapError(unavailable)),
          ),
          Effect.map((continuation) => ({
            continuation: Option.some(continuation),
            result: settled(payload, outcome),
          })),
        ),
      ),
      Match.when('EXISTS', (outcome) => Effect.succeed(settledOnly(settled(payload, outcome)))),
      Match.when('CONFLICT', () =>
        // A concurrent submission of the same content stored it first: look again before calling it a conflict.
        readDocument(transaction, payload.idempotencyKey).pipe(
          Effect.flatMap((current) =>
            identicalRecord(current, payload, stored.scopeDigest)
              ? Effect.succeed(settledOnly(settled(payload, 'EXISTS')))
              : Effect.fail(
                  refused(
                    'EVIDENCE_REF_ALREADY_RECORDED_WITH_OTHER_CONTENT',
                    'The evidence reference holds other content',
                  ),
                ),
          ),
        ),
      ),
      Match.when('SCOPE_MISMATCH', () =>
        Effect.fail(
          refused('SCOPE_DOES_NOT_MATCH_THE_RECORDED_HANDOFF', 'The confirmation is not for the recorded scope'),
        ),
      ),
      Match.when('TARGET_MISMATCH', () =>
        Effect.fail(
          refused('RESULT_NAMES_CONTENT_OUTSIDE_THE_APPROVED_TARGETS', 'A confirmed result names unapproved content'),
        ),
      ),
      Match.when('NO_HANDOFF', () =>
        Effect.fail(refused('NO_HANDOFF_RECORDED_FOR_THIS_MEASURE', 'No handoff is recorded for this measure')),
      ),
      Match.exhaustive,
    );
  }),
});
