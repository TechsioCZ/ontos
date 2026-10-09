import { Effect, Option, Schema } from 'effect';
import { describe, expect, it } from 'effect-rstest';

import {
  PrivacyDispositionDecisionAuthorityResultSchema,
  PrivacyDispositionDecisionSchema,
  PrivacyDispositionDecisionRequestSchema,
  RetentionEvaluationSchema,
  RetentionEvaluationWorkSchema,
  prepareRetentionEvaluationWork,
  validateRetentionEvaluationAgainstWork,
} from '../../shared/domain/privacy-retention-disposition.ts';
import type { PrivacyDispositionDecision } from '../../shared/domain/privacy-retention-disposition.ts';
import { AuthoritativePrivacyRetentionRuleVersionSchema } from '../../shared/domain/privacy-retention-rule.ts';
import { recordDispositionDecisionFromAuthoritativeEvaluation } from '../../src/actions/record-disposition-decision.action.ts';
import type { RecordDispositionDecisionContext } from '../../src/actions/record-disposition-decision.action.ts';
import { PrivacyActionRejected } from '../../src/actions/privacy-operation-action-support.ts';

const tenantId = '10000000-0000-4000-8000-000000000001';
const legalEntityId = '20000000-0000-4000-8000-000000000002';
const principalId = '30000000-0000-4000-8000-000000000003';
const actionInvocationId = '40000000-0000-4000-8000-000000000004';

const scope = {
  authMethod: 'session' as const,
  correlationId: 'retention-decision-test',
  legalEntityId,
  principalId,
  tenantId,
};

const decision = Schema.decodeUnknownSync(PrivacyDispositionDecisionSchema)({
  actorPrincipalRef: principalId,
  authorityRef: 'authority:retention',
  blockerRefs: [],
  contentScopeRefs: ['customer.email'],
  controllerRef: 'controller:techsio',
  decidedAt: '2026-09-15T10:00:00Z',
  decisionRef: 'decision:customer-email:1',
  evaluationRef: 'retention-work:customer-email:1',
  evidenceRefs: ['evidence:retention:1'],
  outcome: 'DELETE',
  ownerExecutionOutcomeRef: null,
  policyRef: 'policy:retention:1',
  policyVersion: 1,
  provenanceRef: 'provenance:evaluation:1',
  reasonRefs: ['retention-expired'],
  ruleRef: 'rule:customer-email',
  ruleVersion: 1,
  ruleVersionId: 'rule-version:customer-email:1',
});

const evaluation = Schema.decodeUnknownSync(RetentionEvaluationSchema)({
  blockerRefs: [],
  contentScopeRefs: ['customer.email'],
  controllerRef: 'controller:techsio',
  evaluatedAt: '1969-12-31T23:00:00Z',
  evaluationRef: decision.evaluationRef,
  evidenceRefs: ['evidence:retention:1'],
  outcome: 'DELETE',
  policyRef: decision.policyRef,
  policyVersion: 1,
  provenanceRef: 'provenance:evaluation:1',
  ruleRef: decision.ruleRef,
  ruleVersion: 1,
  ruleVersionId: decision.ruleVersionId,
  status: 'READY',
});

const run = (
  resolvedEvaluation: typeof evaluation,
  record: (value: PrivacyDispositionDecision) => void,
  authoritativeDecision: PrivacyDispositionDecision = decision,
) => {
  const context: RecordDispositionDecisionContext = {
    actionInvocationId,
    scope,
    services: {
      authority: {
        resolve: (request, authorityContext) =>
          Effect.succeed(
            Schema.decodeUnknownSync(PrivacyDispositionDecisionAuthorityResultSchema)({
              asOf: authorityContext.asOf,
              decision: {
                ...authoritativeDecision,
                actorPrincipalRef: authoritativeDecision.actorPrincipalRef,
                decidedAt: authorityContext.asOf,
                decisionRef: request.decisionRef,
                evaluationRef: request.evaluationRef,
                ownerExecutionOutcomeRef: Option.getOrNull(authoritativeDecision.ownerExecutionOutcomeRef),
              },
              evaluation: resolvedEvaluation,
              legalEntityId,
              status: 'CURRENT',
              tenantId,
            }),
          ),
      },
      recordDispositionDecision: (_tenant, _legalEntity, _invocation, value) =>
        Effect.sync(() => {
          record(value.decision);
          return value.decision;
        }),
      resolveRetentionEvaluation: () => Effect.succeed(resolvedEvaluation),
    },
  };
  return recordDispositionDecisionFromAuthoritativeEvaluation(
    {
      request: {
        decisionRef: authoritativeDecision.decisionRef,
        evaluationRef: resolvedEvaluation.evaluationRef,
      },
    },
    context,
  );
};

describe('record disposition decision Action', () => {
  it.effect('accepts only the evaluation produced from canonical stored retention work', () =>
    Effect.gen(function* acceptProducerEvaluation() {
      const rule = Schema.decodeUnknownSync(AuthoritativePrivacyRetentionRuleVersionSchema)({
        applicability: 'PROSPECTIVE_ONLY',
        authorityRef: 'authority:retention',
        businessStartAt: '1969-12-01T00:00:00Z',
        businessStartRef: 'event:customer-closed',
        contentScopeRef: 'customer.email',
        controllerRef: decision.controllerRef,
        dispositionOutcome: decision.outcome,
        effectiveFrom: '1969-01-01T00:00:00Z',
        effectiveTo: null,
        evidenceRefs: decision.evidenceRefs,
        policyRef: decision.policyRef,
        policyVersion: decision.policyVersion,
        provenanceRef: 'provenance:evaluation:1',
        retentionWindow: { durationDays: 30, kind: 'DURATION' },
        retroactiveApprovalRef: null,
        ruleRef: decision.ruleRef,
        ruleVersion: decision.ruleVersion,
        ruleVersionId: decision.ruleVersionId,
      });
      const preparation = prepareRetentionEvaluationWork(rule, {
        contentScopeRef: rule.contentScopeRef,
        ruleRef: rule.ruleRef,
        ruleVersion: rule.ruleVersion,
        ruleVersionId: rule.ruleVersionId,
        source: 'PERIODIC',
      });
      expect(preparation.valid).toBe(true);
      if (!preparation.valid) {
        return;
      }
      const { work: producedWork } = preparation;
      const storedWork = Schema.decodeUnknownSync(RetentionEvaluationWorkSchema)(
        Schema.encodeUnknownSync(RetentionEvaluationWorkSchema)(producedWork),
      );
      const storedEvaluation = Schema.decodeUnknownSync(RetentionEvaluationSchema)({
        blockerRefs: [],
        contentScopeRefs: storedWork.contentScopeRefs,
        controllerRef: storedWork.controllerRef,
        evaluatedAt: '1969-12-31T23:00:00Z',
        evaluationRef: storedWork.workRef,
        evidenceRefs: storedWork.evidenceRefs,
        outcome: storedWork.dispositionOutcome,
        policyRef: storedWork.policyRef,
        policyVersion: storedWork.policyVersion,
        provenanceRef: storedWork.provenanceRef,
        ruleRef: storedWork.ruleRef,
        ruleVersion: storedWork.ruleVersion,
        ruleVersionId: storedWork.ruleVersionId,
        status: 'READY',
      });
      expect(validateRetentionEvaluationAgainstWork(storedEvaluation, storedWork).valid).toBe(true);

      let recorded = false;
      const result = yield* run(
        storedEvaluation,
        () => {
          recorded = true;
        },
        {
          ...decision,
          evaluationRef: storedEvaluation.evaluationRef,
          provenanceRef: storedEvaluation.provenanceRef,
        },
      );
      expect(result.decisionRef).toBe(decision.decisionRef);
      expect(recorded).toBe(true);

      const { policyRef: _missingPolicy, ...legacyWork } =
        Schema.encodeUnknownSync(RetentionEvaluationWorkSchema)(storedWork);
      expect(Schema.is(RetentionEvaluationWorkSchema)(legacyWork)).toBe(false);
    }),
  );

  it.effect('records only when the current authoritative evaluation matches the decision', () =>
    Effect.gen(function* recordDecision() {
      let recorded = false;
      const result = yield* run(evaluation, () => {
        recorded = true;
      });
      expect(result.decisionRef).toBe(decision.decisionRef);
      expect(recorded).toBe(true);
    }),
  );

  it('does not retain public payload fields for disposition governance or an outcome', () => {
    const decoded = Schema.decodeUnknownSync(PrivacyDispositionDecisionRequestSchema)({
      authorityRef: 'forged-authority',
      decisionRef: decision.decisionRef,
      evaluationRef: decision.evaluationRef,
      evidenceRefs: decision.evidenceRefs,
      outcome: 'DELETE',
    });

    expect(decoded).toEqual({ decisionRef: decision.decisionRef, evaluationRef: decision.evaluationRef });
  });

  it.effect('rejects a trusted authority decision whose outcome differs from the evaluation', () =>
    Effect.gen(function* rejectForgedDecision() {
      let recorded = false;
      const attempt = run(
        evaluation,
        () => {
          recorded = true;
        },
        { ...decision, outcome: 'RETAIN' },
      );
      const failure = yield* Effect.flip(attempt);
      expect(Schema.is(PrivacyActionRejected)(failure)).toBe(true);
      expect(recorded).toBe(false);
    }),
  );

  it.effect('rejects a trusted decision recorded by a different Principal', () =>
    Effect.gen(function* rejectWrongActor() {
      let recorded = false;
      const failure = yield* Effect.flip(
        run(
          evaluation,
          () => {
            recorded = true;
          },
          { ...decision, actorPrincipalRef: 'principal:other' },
        ),
      );
      expect(Schema.is(PrivacyActionRejected)(failure)).toBe(true);
      expect(recorded).toBe(false);
    }),
  );
});
