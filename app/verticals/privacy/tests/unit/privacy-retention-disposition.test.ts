import { Option, Schema } from 'effect';
import { describe, expect, it } from 'effect-rstest';

import {
  assessCurrentRetentionBlockers,
  historicalEvidenceSurvivesPayloadDisposition,
  isTimedRetentionProtectionActive,
  makeRetentionEvaluationWork,
  PrivacyLegalHoldSchema,
  PrivacyDispositionDecisionSchema,
  privacyEvidenceCanProveDelivery,
  sameRetentionEvaluationWork,
  withOwnerExecutionOutcome,
} from '../../shared/domain/privacy-retention-disposition.ts';
import { PrivacyIsoTimestampSchema } from '../../shared/domain/privacy-subject.ts';

const at = Schema.decodeUnknownSync(PrivacyIsoTimestampSchema)('2026-09-14T10:00:00Z');

describe('privacy retention and disposition', () => {
  it('deduplicates periodic and DSR erasure evaluation by exact work identity', () => {
    const common = { contentScopeRefs: ['contact.email'], dueAt: at, ruleRef: 'rule:email', ruleVersion: 1 };
    const periodic = makeRetentionEvaluationWork({ ...common, source: 'PERIODIC' });
    const dsr = makeRetentionEvaluationWork({ ...common, source: 'DSR_ERASURE' });

    expect(sameRetentionEvaluationWork(periodic, dsr)).toBe(true);
  });

  it('fails closed for unknown blockers and blocks current holds', () => {
    const common = {
      blockerRef: 'blocker:1',
      contentScopeRefs: ['contact.email'],
      current: true,
      observedAt: at,
      revision: '1',
    };
    expect(assessCurrentRetentionBlockers([{ ...common, kind: 'UNKNOWN' }]).status).toBe('INDETERMINATE');
    expect(assessCurrentRetentionBlockers([{ ...common, kind: 'LEGAL_HOLD' }]).status).toBe('BLOCKED');
    expect(assessCurrentRetentionBlockers([{ ...common, current: false, kind: 'LEGAL_HOLD' }]).status).toBe('READY');
  });

  it('honors exact, time-bounded holds and their release', () => {
    const hold = Schema.decodeUnknownSync(PrivacyLegalHoldSchema)({
      authorityRef: 'authority:court',
      contentScopeRefs: ['contact.email'],
      effectiveFrom: '2026-09-01T00:00:00Z',
      effectiveTo: '2026-10-01T00:00:00Z',
      holdRef: 'hold:1',
      releasedAt: null,
      reviewRef: 'review:1',
    });
    expect(isTimedRetentionProtectionActive(hold, at)).toBe(true);
    expect(isTimedRetentionProtectionActive({ ...hold, releasedAt: Option.some('2026-09-15T00:00:00Z') }, at)).toBe(
      true,
    );
    expect(isTimedRetentionProtectionActive({ ...hold, releasedAt: Option.some(at) }, at)).toBe(false);
    expect(isTimedRetentionProtectionActive(hold, '2026-08-31T23:59:59Z')).toBe(false);
    expect(isTimedRetentionProtectionActive(hold, '2026-10-01T00:00:00Z')).toBe(false);
  });

  it('preserves accepted meaning only with retained disposition evidence', () => {
    const boundary = {
      acceptedFactRef: 'fact:1',
      contentDisposed: true,
      dispositionEvidenceRef: Option.some('evidence:delete'),
      historicalArtifactRef: 'artifact:1',
      immutableMeaningRef: 'meaning:v1',
      payloadRetained: false,
    } as const;

    expect(historicalEvidenceSurvivesPayloadDisposition(boundary)).toBe(true);
    expect(historicalEvidenceSurvivesPayloadDisposition({ ...boundary, dispositionEvidenceRef: Option.none() })).toBe(
      false,
    );
    expect(historicalEvidenceSurvivesPayloadDisposition({ ...boundary, contentDisposed: false })).toBe(false);
    expect(historicalEvidenceSurvivesPayloadDisposition({ ...boundary, payloadRetained: true })).toBe(false);
  });

  it('keeps disposition separate from owner execution and export retention separate from delivery proof', () => {
    const decision = Schema.decodeUnknownSync(PrivacyDispositionDecisionSchema)({
      blockerRefs: ['object-lock:1'],
      contentScopeRefs: ['contact.email'],
      decidedAt: '2026-09-14T10:00:00Z',
      decisionRef: 'decision:delete:1',
      evidenceRefs: ['evidence:rule'],
      outcome: 'DELETE',
      ownerExecutionOutcomeRef: null,
      reasonRefs: ['retention-expired'],
      ruleRef: 'rule:email',
      ruleVersion: 1,
    });

    expect(withOwnerExecutionOutcome(decision, 'outcome:blocked-by-object-lock').outcome).toBe('DELETE');
    expect(privacyEvidenceCanProveDelivery('TEMPORARY_DSR_EXPORT')).toBe(false);
    expect(privacyEvidenceCanProveDelivery('DELIVERY_EVIDENCE')).toBe(true);
  });
});
