import type { ScopedRoutineInvoker } from '@app/core-runtime';
import type { PrivacyMeasureHandoff } from '@app/privacy/domain/privacy-measure-handoff';
import { Effect, Result, Schema } from 'effect';

import {
  communicationsMeasureOf,
  fingerprintCommunicationsHandoff,
  ownerScopeCanonicalText,
  sha256Hex,
} from '../../shared/privacy-owner/measure-handoff.ts';
import { workerRecordPrivacyMeasureHandoffRoutine } from '../persistence/communications-routines.ts';
import { RecordHandoffAnswerSchema } from '../persistence/privacy-measure-records.ts';

const decodeAnswer = Schema.decodeUnknownEffect(RecordHandoffAnswerSchema);

/**
 * Records that Privacy handed this measure to the owner: its identity, the fingerprint of the exact complete handoff, a digest
 * of its exact owner scope and its approved targets. Append-only and idempotent: the first record wins and a later one under
 * the same identity either is the same handoff or is reported as a conflict. It records nothing about the subject, executes
 * nothing and changes no owner data. A handoff the owner cannot evaluate is recorded too, under an `unscoped` digest, so
 * that its receipt can say so truthfully.
 */
export const recordPrivacyMeasureHandoff = Effect.fn('CommunicationsPrivacyHandoff.record')(function* record(
  invoker: ScopedRoutineInvoker,
  handoff: PrivacyMeasureHandoff,
  originatorInvocationId: string,
) {
  const fingerprint = yield* fingerprintCommunicationsHandoff(handoff);
  const dispatched = communicationsMeasureOf(handoff);
  const scopeText = Result.isSuccess(dispatched)
    ? ownerScopeCanonicalText(dispatched.success)
    : `unscoped:${fingerprint}`;
  const scopeDigest = yield* sha256Hex(scopeText);
  const rows = yield* invoker.invoke(workerRecordPrivacyMeasureHandoffRoutine, [
    handoff.idempotencyKey,
    handoff.measureId,
    handoff.taskId,
    handoff.sourceDecisionRef,
    handoff.sourceDecisionRevision,
    fingerprint,
    scopeDigest,
    handoff.resourceRefs,
    originatorInvocationId,
  ]);
  const answer = yield* decodeAnswer(rows[0]?.result);
  return {
    fingerprint,
    outcome:
      answer.outcome === 'CONFLICT' || answer.record.handoffFingerprint !== fingerprint ? 'CONFLICT' : answer.outcome,
  };
});
