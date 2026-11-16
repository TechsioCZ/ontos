import { Schema } from 'effect';
import { PrivacyMeasureHandoffSchema } from '../../shared/domain/privacy-measure-handoff.ts';
import {
  PrivacyDispositionDecisionSchema,
  RetentionEvaluationSchema,
} from '../../shared/domain/privacy-retention-disposition.ts';

export const makeMeasureExecutionFixture = (tenantId: string, suffix = tenantId) => {
  const resource = `integration.symmy.job:${suffix}`;
  const content = `${resource}#integration.symmy.job-intent`;
  const decidedAt = '2026-11-01T10:00:00.000Z';
  const common = {
    blockerRefs: [],
    contentScopeRefs: [content],
    controllerRef: 'fixture:controller',
    evaluationRef: `fixture:evaluation:${suffix}`,
    evidenceRefs: ['fixture:retention-evidence'],
    outcome: 'DELETE',
    policyRef: 'fixture:retention-policy',
    policyVersion: 1,
    provenanceRef: 'fixture:retention-provenance',
    ruleRef: `fixture:rule:${suffix}`,
    ruleVersion: 1,
    ruleVersionId: `fixture:rule-version:${suffix}`,
  };
  const decisionWire = {
    ...common,
    actorPrincipalRef: 'fixture:approved-governance-actor',
    authorityRef: 'fixture:disposition-authority',
    decidedAt,
    decisionRef: `fixture:decision:${suffix}`,
    ownerExecutionOutcomeRef: null,
    reasonRefs: ['fixture:explicit-retention-end'],
  };
  const evaluationWire = { ...common, evaluatedAt: decidedAt, status: 'READY' };
  const handoff = Schema.decodeUnknownSync(PrivacyMeasureHandoffSchema)({
    contentScopeRefs: [content],
    controllerObligationRef: null,
    dispositionDecision: 'DELETE',
    expectedEvidenceRefs: ['fixture:owner-receipt'],
    idempotencyKey: `fixture:measure-key:${suffix}`,
    kind: 'DELETE',
    measureId: `fixture:measure:${suffix}`,
    owningCapability: 'integration.symmy',
    preconditionRefs: [common.evaluationRef],
    requestedAt: decidedAt,
    requestedResult: 'INTENT_PURGED',
    resourceRefs: [resource],
    right: null,
    sourceDecisionRef: decisionWire.decisionRef,
    sourceDecisionRevision: 1,
    subjectRef: `fixture:subject:${suffix}`,
    taskId: `fixture:task:${suffix}`,
    tenantId,
  });
  return {
    content,
    decidedAt,
    decision: Schema.decodeUnknownSync(PrivacyDispositionDecisionSchema)(decisionWire),
    decisionWire,
    evaluation: Schema.decodeUnknownSync(RetentionEvaluationSchema)(evaluationWire),
    evaluationWire,
    handoff,
  };
};
