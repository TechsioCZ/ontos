import type { OperationalScope, ScopedTransactionExecutor } from '@app/core-runtime';
import { PrivacyOwnerCoverageRequestSchema } from '../../shared/apis/privacy-owner-coverage.ts';
import type {
  PrivacyOwnerExecutionOutcomeRequest,
  PrivacyOwnerExecutionReceipt,
} from '../../shared/apis/privacy-owner-execution-outcome.ts';
import {
  communicationsMeasureOf,
  evidenceRecordsOf,
  fingerprintCommunicationsHandoff,
  ownerScopeCanonicalText,
  privacyOutcomeOf,
  rejectedOutcomeOf,
  sha256Hex,
} from '../../shared/privacy-owner/measure-handoff.ts';
import type { DispatchedMeasure, StoredExecutionEvidence } from '../../shared/privacy-owner/measure-handoff.ts';
import { evaluateCommunicationsOwnerMeasure } from '../../shared/privacy-owner/outcome.ts';
import type { Crypto } from 'effect';
import { Context, DateTime, Effect, Option, Result, Schema } from 'effect';
import type { PrivacyOwnerCoverageResultEncoded } from '@app/shared-contracts';

import { safeCauseOf } from '../domain/intake/safe-cause.ts';
import { readPrivacyMeasureHandoffRoutine } from '../persistence/communications-routines.ts';
import { HandoffDocumentSchema } from '../persistence/privacy-measure-records.ts';
import { PrivacyOwnerCoverageUnavailable } from './privacy-owner-coverage-unavailable.ts';
import { defaultPrivacyOwnerCoverageOptions, privacyOwnerCoverageForScope } from './privacy-owner-coverage.service.ts';
import type { PrivacyOwnerCoverageOptions } from './privacy-owner-coverage.service.ts';

/**
 * The owner receipt of one Privacy Measure the owner took over (#1410, #600-#602). It READS the owner's recorded handoff and its
 * human-confirmed evidence, asks the owner's own coverage for the exact scope the handoff carries, and lets the existing
 * outcome evaluator say what is evidenced. It writes nothing and cannot cause a write: a measure with no confirmed evidence
 * is received and nothing more.
 */
const decodeDocument = Schema.decodeUnknownEffect(HandoffDocumentSchema);

const unavailable = (cause: unknown) =>
  Object.defineProperty(
    new PrivacyOwnerCoverageUnavailable({ reason: 'The owner handoff records are unavailable' }),
    'cause',
    { enumerable: false, value: safeCauseOf(cause) },
  );

export interface PrivacyOwnerExecutionReceiptService {
  readonly receipt: (
    request: PrivacyOwnerExecutionOutcomeRequest,
  ) => Effect.Effect<Option.Option<PrivacyOwnerExecutionReceipt>, PrivacyOwnerCoverageUnavailable, Crypto.Crypto>;
}

export class OwnerExecutionReceipt extends Context.Service<
  OwnerExecutionReceipt,
  PrivacyOwnerExecutionReceiptService
>()('@app/communications/services/privacy-owner-execution-receipt.service/OwnerExecutionReceipt') {}

/** Coverage the owner cannot give for a scope it cannot even ask about: it says so and never proves anything. */
const incompleteCoverage = (
  measure: DispatchedMeasure['measure'],
  assessedAt: string,
): PrivacyOwnerCoverageResultEncoded => ({
  assessedAt,
  contentStatus: 'UNKNOWN',
  coverageParts: [],
  coverageStatus: 'INDETERMINATE',
  evidenceRefs: [],
  scope: measure.scope,
});

const decodeCoverageRequest = Schema.decodeUnknownResult(PrivacyOwnerCoverageRequestSchema);

export const privacyOwnerExecutionReceiptForScope = (
  transaction: ScopedTransactionExecutor,
  scope: OperationalScope,
  options: PrivacyOwnerCoverageOptions = defaultPrivacyOwnerCoverageOptions,
): PrivacyOwnerExecutionReceiptService => ({
  receipt: Effect.fn('CommunicationsPrivacyReceipt.receipt')(function* receipt(request) {
    const { handoff } = request;
    if (handoff.tenantId !== scope.tenantId) {
      return Option.none();
    }
    const attempt = request.attempt ?? 1;
    const { fingerprint, rows } = yield* Effect.all(
      {
        fingerprint: fingerprintCommunicationsHandoff(handoff).pipe(Effect.mapError(unavailable)),
        rows: transaction
          .invoke(readPrivacyMeasureHandoffRoutine, [handoff.idempotencyKey])
          .pipe(Effect.mapError(unavailable)),
      },
      { concurrency: 2 },
    );
    const document = yield* decodeDocument(rows[0]?.result).pipe(Effect.mapError(unavailable));
    if (Option.isNone(document.record)) {
      return Option.none();
    }
    const { record } = document;
    const stored = record.value;
    const now = yield* DateTime.now;
    const common = {
      attempt,
      handoff,
      occurredAt: stored.receivedAt,
      outcomeId: `communications.core.privacy-owner-outcome:${stored.handoffFingerprint}:${String(attempt)}`,
      recordedAt: now,
    };
    const handoffRef = `communications.core.privacy-measure-handoff:${stored.handoffFingerprint}`;
    const reject = (reason: Parameters<typeof rejectedOutcomeOf>[0]['reason']) =>
      Option.some({
        handoffFingerprint: stored.handoffFingerprint,
        outcome: rejectedOutcomeOf({ ...common, evidenceRefs: [handoffRef], reason }),
      });
    const dispatched = communicationsMeasureOf(handoff);
    if (Result.isFailure(dispatched)) {
      return reject(dispatched.failure);
    }
    const digest = yield* sha256Hex(ownerScopeCanonicalText(dispatched.success)).pipe(Effect.mapError(unavailable));
    if (stored.handoffFingerprint !== fingerprint || stored.scopeDigest !== digest) {
      return reject('HANDOFF_OWNER_SCOPE_IS_ABSENT_OR_INVALID');
    }
    const { lookups, measure } = dispatched.success;
    const coverageRequest = decodeCoverageRequest({ scope: measure.scope, trustedLookups: lookups });
    const coverage = Result.isFailure(coverageRequest)
      ? Option.some({ coverage: incompleteCoverage(measure, DateTime.formatIso(now)) })
      : yield* privacyOwnerCoverageForScope(transaction, scope, options).coverage(coverageRequest.success);
    if (Option.isNone(coverage)) {
      return Option.none();
    }
    const evidence: readonly StoredExecutionEvidence[] = document.evidence;
    const owner = evaluateCommunicationsOwnerMeasure({
      blockers: [],
      confirmedAt: DateTime.formatIso(now),
      coverage: coverage.value.coverage,
      evidence: evidenceRecordsOf(evidence, measure, digest),
      evidenceRefs: [handoffRef],
      measure,
      outcomeRef: common.outcomeId,
    });
    return Option.some({
      handoffFingerprint: stored.handoffFingerprint,
      outcome: privacyOutcomeOf({ ...common, outcome: owner }),
    });
  }),
});
