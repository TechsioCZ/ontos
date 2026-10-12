import { Option, Schema } from 'effect';
import { describe, expect, it } from 'effect-rstest';

import {
  assessCurrentRetentionBlockers,
  historicalEvidenceSurvivesPayloadDisposition,
  isTimedRetentionProtectionActive,
  makeRetentionEvaluationWork,
  prepareRetentionEvaluationWork,
  PrivacyLegalHoldSchema,
  PrivacyDispositionDecisionSchema,
  RetentionEvaluationSchema,
  privacyEvidenceCanProveDelivery,
  sameRetentionEvaluationWork,
  validateDispositionDecisionAgainstEvaluation,
  validateRetentionEvaluationAgainstWork,
  validateRetentionProtection,
  withOwnerExecutionOutcome,
} from '../../shared/domain/privacy-retention-disposition.ts';
import { AuthoritativePrivacyRetentionRuleVersionSchema } from '../../shared/domain/privacy-retention-rule.ts';
import { PrivacyIsoTimestampSchema } from '../../shared/domain/privacy-subject.ts';

const at = Schema.decodeUnknownSync(PrivacyIsoTimestampSchema)('2026-09-14T10:00:00Z');
const authoritativeRule = Schema.decodeUnknownSync(AuthoritativePrivacyRetentionRuleVersionSchema)({
  applicability: 'PROSPECTIVE_ONLY',
  authorityRef: 'authority:retention',
  businessStartAt: '2026-01-01T00:00:00Z',
  businessStartRef: 'event:account-closed',
  contentScopeRef: 'contact.email',
  controllerRef: 'controller:techsio',
  dispositionOutcome: 'DELETE',
  effectiveFrom: '2026-01-01T00:00:00Z',
  effectiveTo: null,
  evidenceRefs: ['evidence:rule'],
  policyRef: 'policy:retention:1',
  policyVersion: 1,
  provenanceRef: 'provenance:rule:1',
  retentionWindow: { durationDays: 30, kind: 'DURATION' },
  retroactiveApprovalRef: null,
  ruleRef: 'rule:email',
  ruleVersion: 1,
  ruleVersionId: 'rule-version:email:1',
});

describe('privacy retention and disposition', () => {
  it('deduplicates periodic and DSR erasure evaluation by exact work identity', () => {
    const common = { rule: authoritativeRule };
    const periodic = makeRetentionEvaluationWork({ ...common, source: 'PERIODIC' });
    const dsr = makeRetentionEvaluationWork({ ...common, source: 'DSR_ERASURE' });

    expect(sameRetentionEvaluationWork(periodic, dsr)).toBe(true);
    expect(periodic).toMatchObject({
      controllerRef: authoritativeRule.controllerRef,
      dispositionOutcome: authoritativeRule.dispositionOutcome,
      policyRef: authoritativeRule.policyRef,
      policyVersion: authoritativeRule.policyVersion,
      status: 'PENDING',
    });

    const prepared = prepareRetentionEvaluationWork(authoritativeRule, {
      contentScopeRef: authoritativeRule.contentScopeRef,
      ruleRef: authoritativeRule.ruleRef,
      ruleVersion: authoritativeRule.ruleVersion,
      ruleVersionId: authoritativeRule.ruleVersionId,
      source: 'PERIODIC',
    });
    expect(prepared).toEqual({ valid: true, work: periodic });
    expect(
      prepareRetentionEvaluationWork(authoritativeRule, {
        contentScopeRef: 'contact.phone',
        ruleRef: authoritativeRule.ruleRef,
        ruleVersion: authoritativeRule.ruleVersion,
        ruleVersionId: authoritativeRule.ruleVersionId,
        source: 'PERIODIC',
      }).valid,
    ).toBe(false);
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
      actorPrincipalRef: 'principal:privacy-reviewer',
      authorityKind: 'LEGAL_HOLD_AUTHORITY',
      authorityRef: 'authority:court',
      contentScopeRefs: ['contact.email'],
      controllerRef: 'controller:techsio',
      effectiveFrom: '2026-09-01T00:00:00Z',
      effectiveTo: '2026-10-01T00:00:00Z',
      evidenceRefs: ['evidence:hold:1'],
      holdRef: 'hold:1',
      policyRef: 'policy:retention:1',
      policyVersion: 1,
      provenanceRef: 'provenance:hold:1',
      reasonTypeRef: 'legal-hold:litigation',
      reasonTypeVersion: 1,
      releaseConditionRef: null,
      releasedAt: null,
      releasedByPrincipalRef: null,
      releaseEvidenceRefs: [],
      releaseReasonRef: null,
      releaseRef: null,
      reviewDueAt: '2026-09-20T00:00:00Z',
      reviewedAt: null,
      reviewEvidenceRefs: [],
      reviewRef: 'review:1',
    });
    expect(validateRetentionProtection(hold).valid).toBe(true);
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
      actorPrincipalRef: 'principal:privacy-reviewer',
      authorityRef: 'authority:retention',
      blockerRefs: ['object-lock:1'],
      contentScopeRefs: ['contact.email'],
      controllerRef: 'controller:techsio',
      decidedAt: '2026-09-14T10:00:00Z',
      decisionRef: 'decision:delete:1',
      evaluationRef: 'retention-evaluation:1',
      evidenceRefs: ['evidence:rule'],
      outcome: 'DELETE',
      ownerExecutionOutcomeRef: null,
      policyRef: 'policy:retention:1',
      policyVersion: 1,
      provenanceRef: 'provenance:evaluation:1',
      reasonRefs: ['retention-expired'],
      ruleRef: 'rule:email',
      ruleVersion: 1,
      ruleVersionId: 'rule-version:email:1',
    });

    const evaluation = Schema.decodeUnknownSync(RetentionEvaluationSchema)({
      blockerRefs: ['object-lock:1'],
      contentScopeRefs: ['contact.email'],
      controllerRef: 'controller:techsio',
      evaluatedAt: '2026-09-14T09:00:00Z',
      evaluationRef: 'retention-evaluation:1',
      evidenceRefs: ['evidence:rule'],
      outcome: 'DELETE',
      policyRef: 'policy:retention:1',
      policyVersion: 1,
      provenanceRef: 'provenance:evaluation:1',
      ruleRef: 'rule:email',
      ruleVersion: 1,
      ruleVersionId: 'rule-version:email:1',
      status: 'BLOCKED',
    });
    expect(validateDispositionDecisionAgainstEvaluation(decision, evaluation).valid).toBe(true);

    const work = makeRetentionEvaluationWork({
      rule: authoritativeRule,
      source: 'PERIODIC',
    });
    const workEvaluation = { ...evaluation, evaluationRef: work.workRef, provenanceRef: work.provenanceRef };
    expect(validateRetentionEvaluationAgainstWork(workEvaluation, work).valid).toBe(true);

    expect(withOwnerExecutionOutcome(decision, 'outcome:blocked-by-object-lock').outcome).toBe('DELETE');
    expect(privacyEvidenceCanProveDelivery('TEMPORARY_DSR_EXPORT')).toBe(false);
    expect(privacyEvidenceCanProveDelivery('DELIVERY_EVIDENCE')).toBe(true);
  });

  it('rejects INDETERMINATE as a disposition decision outcome', () => {
    expect(() =>
      Schema.decodeUnknownSync(PrivacyDispositionDecisionSchema)({
        actorPrincipalRef: 'principal:privacy-reviewer',
        authorityRef: 'authority:retention',
        blockerRefs: [],
        contentScopeRefs: ['contact.email'],
        controllerRef: 'controller:techsio',
        decidedAt: '2026-09-14T10:00:00Z',
        decisionRef: 'decision:indeterminate:1',
        evaluationRef: 'retention-evaluation:1',
        evidenceRefs: ['evidence:rule'],
        outcome: 'INDETERMINATE',
        ownerExecutionOutcomeRef: null,
        policyRef: 'policy:retention:1',
        policyVersion: 1,
        provenanceRef: 'provenance:evaluation:1',
        reasonRefs: ['unknown'],
        ruleRef: 'rule:email',
        ruleVersion: 1,
        ruleVersionId: 'rule-version:email:1',
      }),
    ).toThrow();
  });

  it('requires complete release and review evidence', () => {
    const incompleteRelease = {
      actorPrincipalRef: 'principal:privacy-reviewer',
      authorityKind: 'EXCEPTION_AUTHORITY' as const,
      authorityRef: 'authority:exception',
      contentScopeRefs: ['contact.email'],
      controllerRef: 'controller:techsio',
      effectiveFrom: '2026-09-01T00:00:00Z',
      effectiveTo: '2026-10-01T00:00:00Z',
      evidenceRefs: ['evidence:exception:1'],
      exceptionRef: 'exception:1',
      policyRef: 'policy:retention:1',
      policyVersion: 1,
      provenanceRef: 'provenance:exception:1',
      reasonTypeRef: 'exception:litigation',
      reasonTypeVersion: 1,
      releaseConditionRef: null,
      releasedAt: null,
      releasedByPrincipalRef: null,
      releaseEvidenceRefs: [],
      releaseReasonRef: 'release:approved',
      releaseRef: null,
      reviewDueAt: '2026-09-20T00:00:00Z',
      reviewedAt: null,
      reviewEvidenceRefs: [],
      reviewRef: 'review:exception:1',
    };
    const exception = Schema.decodeUnknownSync(PrivacyLegalHoldSchema)({
      ...incompleteRelease,
      authorityKind: 'LEGAL_HOLD_AUTHORITY',
      holdRef: 'hold:invalid',
    });
    expect(validateRetentionProtection(exception).valid).toBe(false);
  });
});
