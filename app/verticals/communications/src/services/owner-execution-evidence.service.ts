import type { ScopedTransactionExecutor } from '@app/core-runtime';
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
const decodeAnswer = Schema.decodeUnknownEffect(RecordEvidenceAnswerSchema);

export interface OwnerExecutionEvidenceService {
  readonly record: (
    payload: RecordOwnerExecutionEvidencePayload,
    confirmationInvocationId: string,
  ) => Effect.Effect<RecordOwnerExecutionEvidenceResult, typeof OwnerExecutionEvidenceErrorSchema.Type>;
}

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
    const rows = yield* transaction
      .invoke(readPrivacyMeasureHandoffRoutine, [payload.idempotencyKey])
      .pipe(Effect.mapError(unavailable));
    const document = yield* decodeDocument(rows[0]?.result).pipe(Effect.mapError(unavailable));
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
      Match.when('RECORDED', (outcome) => Effect.succeed(settled(payload, outcome))),
      Match.when('EXISTS', (outcome) => Effect.succeed(settled(payload, outcome))),
      Match.when('CONFLICT', () =>
        Effect.fail(
          refused('EVIDENCE_REF_ALREADY_RECORDED_WITH_OTHER_CONTENT', 'The evidence reference holds other content'),
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
