import { describe, expect, it } from 'effect-rstest';

import {
  createPrivacyEligibilityEvidence,
  evaluatePrivacyEligibility,
  resolvePrivacyEligibilityInputs,
  assessPrivacyEligibilityBoundary,
  privacyEligibilityDecisionRevision,
  reconcilePrivacyEligibilityHandoff,
} from '../../shared/domain/privacy-processing-eligibility.ts';
import type { ConsentDecision } from '../../shared/domain/privacy-consent-decision.ts';
import type { IntendedProcessingScope } from '../../shared/domain/privacy-processing-eligibility.ts';

const scope: IntendedProcessingScope = {
  controllerRef: 'controller:one',
  dataCategoryRefs: ['category:email'],
  operation: 'send-email',
  processingScopeRef: { scopeId: 'scope:one', scopeType: 'privacy.processing-scope' },
  purposeRef: 'purpose:marketing',
  purposeVersionId: 'purpose-version:one',
  recipientRefs: ['recipient:mail'],
};
const currentness = {
  authoritative: true,
  observedAt: '2026-01-01T00:00:00Z',
  revision: 'rev:one',
  sourceRef: 'source:one',
};
const applicabilityScope = {
  facts: [
    { dimension: 'CONTROLLER_SCOPE' as const, value: scope.controllerRef },
    ...scope.dataCategoryRefs.map((value) => ({ dimension: 'CATEGORY' as const, value })),
    { dimension: 'PROCESSING_PURPOSE' as const, value: scope.purposeRef },
    { dimension: 'PROCESSING_PURPOSE_VERSION' as const, value: scope.purposeVersionId },
  ],
  operation: scope.operation,
  processingScopeRef: scope.processingScopeRef,
};
const applicability = {
  evaluatedAt: '2026-01-01T00:00:00Z',
  evaluatedScope: applicabilityScope,
  evidenceRefs: ['evidence:one'],
  outcome: 'APPLICABLE' as const,
  policyIdentities: [],
  proposedActivity: true,
  reasonCodes: ['explicit_policy_match'],
  responsibilityAssignmentRefs: [],
};
const noObjection = { currentness, objectionRef: 'objection:none', scope, status: 'ABSENT' as const };
const noRestriction = { currentness, restrictionRef: 'restriction:none', scope, status: 'ABSENT' as const };
const consentDecision = (decision: ConsentDecision['decision']): ConsentDecision => ({
  actorEvidence: {
    actor: {
      principalId: '00000000-0000-4000-8000-000000000002',
      tenantId: '00000000-0000-4000-8000-000000000001',
    },
    attributedAt: '2026-01-01T00:00:00Z',
    authMethod: 'session',
    impersonatedBy: null,
  },
  decision,
  decisionId: `decision:${decision.toLowerCase()}`,
  effectiveAt: '2026-01-01T00:00:00Z',
  flowEvidenceRefs: ['flow:one'],
  noticeEvidenceRefs: ['notice-provision:one'],
  provenanceRefs: ['action:one'],
  recordedAt: '2026-01-01T00:00:00Z',
  scope: {
    controllerRef: scope.controllerRef,
    materialDimensions: [],
    privacySubjectRef: {
      moduleId: 'privacy.core',
      resourceId: 'subject:one',
      resourceType: 'privacy.core.privacy-subject',
      tenantId: '00000000-0000-4000-8000-000000000001',
    },
    processingPurposeRef: {
      moduleId: 'privacy.core',
      resourceId: scope.purposeRef,
      resourceType: 'privacy.core.processing-purpose',
      tenantId: '00000000-0000-4000-8000-000000000001',
    },
    purposeMeaning: 'Send marketing email',
    purposeVersionRef: scope.purposeVersionId,
    scopeRef: scope.processingScopeRef.scopeId,
  },
});

describe('privacy processing eligibility input resolution', () => {
  it('compares the complete applicability scope instead of filling missing facts from the intended scope', () => {
    const input = {
      applicability: {
        ...applicability,
        evaluatedScope: {
          ...applicabilityScope,
          facts: applicabilityScope.facts.map((fact) =>
            fact.dimension === 'CONTROLLER_SCOPE' ? { ...fact, value: 'controller:other' } : fact,
          ),
        },
      },
      applicabilityCurrentness: currentness,
      applicabilityScope,
      asOf: '2026-01-02T00:00:00Z',
      consent: null,
      consentCurrentness: null,
      intendedScope: scope,
      legalBasis: { basisRef: 'legal-basis:contract', basisVersion: 'v1', currentness, scope },
      objection: null,
      restriction: null,
    };

    expect(resolvePrivacyEligibilityInputs(input).applicability).toMatchObject({
      reason: 'applicability_scope_mismatch',
      state: 'STALE',
    });
  });

  it('requires exact scope and authoritative currentness for every supplied input', () => {
    const result = resolvePrivacyEligibilityInputs({
      applicability,
      applicabilityCurrentness: currentness,
      applicabilityScope,
      asOf: '2026-01-02T00:00:00Z',
      consent: null,
      consentCurrentness: null,
      intendedScope: scope,
      legalBasis: { basisRef: 'legal-basis:consent', basisVersion: 'v1', currentness, scope },
      objection: null,
      restriction: null,
    });
    expect(result.applicability.state).toBe('CURRENT');
    expect(result.legalBasis.state).toBe('CURRENT');
    expect(result.consent.state).toBe('ABSENT');
  });

  it('fails closed on mismatched scope, stale observation, and non-authoritative source', () => {
    const result = resolvePrivacyEligibilityInputs({
      applicability: { ...applicability, evaluatedScope: { ...applicability.evaluatedScope, operation: 'delete' } },
      applicabilityCurrentness: currentness,
      applicabilityScope,
      asOf: '2026-01-02T00:00:00Z',
      consent: null,
      consentCurrentness: null,
      intendedScope: scope,
      legalBasis: {
        basisRef: 'legal-basis:contract',
        basisVersion: 'v1',
        currentness: { ...currentness, authoritative: false },
        scope: { ...scope, purposeRef: 'purpose:other' },
      },
      objection: null,
      restriction: null,
    });
    expect(result.applicability.state).toBe('STALE');
    expect(result.legalBasis.state).toBe('STALE');
  });

  it('returns ALLOWED only when applicability and every mandatory input is current', () => {
    const result = evaluatePrivacyEligibility({
      applicability,
      applicabilityCurrentness: currentness,
      applicabilityScope,
      asOf: '2026-01-02T00:00:00Z',
      consent: null,
      consentCurrentness: null,
      intendedScope: scope,
      legalBasis: { basisRef: 'legal-basis:contract', basisVersion: 'v1', currentness, scope },
      objection: noObjection,
      restriction: noRestriction,
    });
    expect(result.outcome).toBe('ALLOWED');
  });

  it('fails closed when objection or restriction absence is not authoritative and current', () => {
    const absent = evaluatePrivacyEligibility({
      applicability,
      applicabilityCurrentness: currentness,
      applicabilityScope,
      asOf: '2026-01-02T00:00:00Z',
      consent: null,
      consentCurrentness: null,
      intendedScope: scope,
      legalBasis: { basisRef: 'legal-basis:contract', basisVersion: 'v1', currentness, scope },
      objection: null,
      restriction: null,
    });
    const unavailable = evaluatePrivacyEligibility({
      applicability,
      applicabilityCurrentness: currentness,
      applicabilityScope,
      asOf: '2026-01-02T00:00:00Z',
      consent: null,
      consentCurrentness: null,
      intendedScope: scope,
      legalBasis: { basisRef: 'legal-basis:contract', basisVersion: 'v1', currentness, scope },
      objection: {
        ...noObjection,
        currentness: { ...currentness, authoritative: false },
      },
      restriction: noRestriction,
    });

    expect(absent).toMatchObject({
      outcome: 'INDETERMINATE',
      reasonCodes: expect.arrayContaining(['objection_objection_absent', 'restriction_restriction_absent']),
    });
    expect(unavailable).toMatchObject({
      outcome: 'INDETERMINATE',
      reasonCodes: expect.arrayContaining(['objection_source_not_authoritative']),
    });
  });

  it('returns INDETERMINATE for missing or unavailable mandatory inputs', () => {
    const result = evaluatePrivacyEligibility({
      applicability,
      applicabilityCurrentness: currentness,
      applicabilityScope,
      asOf: '2026-01-02T00:00:00Z',
      consent: null,
      consentCurrentness: null,
      intendedScope: scope,
      legalBasis: { basisRef: 'legal-basis:consent', basisVersion: 'v1', currentness, scope },
      objection: noObjection,
      restriction: noRestriction,
    });
    expect(result.outcome).toBe('INDETERMINATE');
    expect(result.reasonCodes).toContain('consent_consent_absent');
  });

  it('gives a reliable exact-scope blocker precedence over unknown mandatory inputs', () => {
    const result = evaluatePrivacyEligibility({
      applicability,
      applicabilityCurrentness: currentness,
      applicabilityScope,
      asOf: '2026-01-02T00:00:00Z',
      consent: null,
      consentCurrentness: null,
      intendedScope: scope,
      legalBasis: {
        basisRef: 'legal-basis:contract',
        basisVersion: 'v1',
        currentness: { ...currentness, authoritative: false },
        scope,
      },
      objection: { currentness, objectionRef: 'objection:one', scope, status: 'ACTIVE' },
      restriction: null,
    });
    expect(result.outcome).toBe('NOT_ALLOWED');
    expect(result.reasonCodes).toEqual(['processing_objection_active']);
  });

  it('does not turn conflicting applicability into an allow', () => {
    const result = evaluatePrivacyEligibility({
      applicability: { ...applicability, outcome: 'CONFLICT' },
      applicabilityCurrentness: currentness,
      applicabilityScope,
      asOf: '2026-01-02T00:00:00Z',
      consent: null,
      consentCurrentness: null,
      intendedScope: scope,
      legalBasis: { basisRef: 'legal-basis:contract', basisVersion: 'v1', currentness, scope },
      objection: noObjection,
      restriction: noRestriction,
    });
    expect(result.outcome).toBe('INDETERMINATE');
  });

  it('creates durable evidence from the decision without copying personal-data payloads', () => {
    const result = evaluatePrivacyEligibility({
      applicability,
      applicabilityCurrentness: currentness,
      applicabilityScope,
      asOf: '2026-01-02T00:00:00Z',
      consent: null,
      consentCurrentness: null,
      intendedScope: scope,
      legalBasis: { basisRef: 'legal-basis:contract', basisVersion: 'v1', currentness, scope },
      objection: noObjection,
      restriction: noRestriction,
    });
    const evidence = createPrivacyEligibilityEvidence({
      authoritativeReferences: [
        { kind: 'purpose-version', reference: scope.purposeVersionId, revision: '1' },
        { kind: 'legal-basis-assignment', reference: 'legal-basis-assignment:one', revision: '1' },
      ],
      outcome: result,
      policyRevisions: [{ policyRef: 'privacy.applicability.eu-eea.v1', revision: '1' }],
    });
    expect(evidence.trustedDecisionTime).toBe(result.evaluatedAt);
    expect(evidence.evaluatedScope).toEqual(scope);
    expect(evidence.policyRevisions).toEqual([{ policyRef: 'privacy.applicability.eu-eea.v1', revision: '1' }]);
    expect(evidence.currentnessConditions).toHaveLength(5);
    expect(evidence.currentnessConditions.find(({ input }) => input === 'legalBasis')?.state).toBe('CURRENT');
    expect('personalData' in evidence).toBe(false);
  });

  it('retains a historical blocker and currentness reason instead of recomputing it', () => {
    const result = evaluatePrivacyEligibility({
      applicability,
      applicabilityCurrentness: currentness,
      applicabilityScope,
      asOf: '2026-01-02T00:00:00Z',
      consent: null,
      consentCurrentness: null,
      intendedScope: scope,
      legalBasis: { basisRef: 'legal-basis:contract', basisVersion: 'v1', currentness, scope },
      objection: { currentness, objectionRef: 'objection:one', scope, status: 'ACTIVE' },
      restriction: noRestriction,
    });
    const evidence = createPrivacyEligibilityEvidence({ outcome: result });
    expect(evidence.outcome).toBe('NOT_ALLOWED');
    expect(evidence.reasonCodes).toEqual(['processing_objection_active']);
    expect(evidence.currentnessConditions.find(({ input }) => input === 'objection')?.revision).toBe('rev:one');
  });

  it('requires the consumer-declared recheck at its last controllable boundary', () => {
    const decision = evaluatePrivacyEligibility({
      applicability,
      applicabilityCurrentness: currentness,
      applicabilityScope,
      asOf: '2026-01-02T00:00:00Z',
      consent: null,
      consentCurrentness: null,
      intendedScope: scope,
      legalBasis: { basisRef: 'legal-basis:contract', basisVersion: 'v1', currentness, scope },
      objection: noObjection,
      restriction: noRestriction,
    });
    const contract = {
      consumerRef: 'consumer:mailer',
      invalidationBehavior: 'RECHECK_BEFORE_BOUNDARY' as const,
      lastControllableBoundary: 'before-send',
      operationRef: 'send-email',
      recheckRequiredAtBoundary: true,
    };
    expect(assessPrivacyEligibilityBoundary({ boundary: 'before-send', contract, decision }).result).toBe(
      'RECHECK_REQUIRED',
    );
    expect(
      assessPrivacyEligibilityBoundary({ boundary: 'before-send', contract, decision, latest: decision }).result,
    ).toBe('REUSE_ALLOWED');
    expect(
      assessPrivacyEligibilityBoundary({ boundary: 'after-send', contract, decision, latest: decision }).result,
    ).toBe('STOPPED');
  });

  it('includes the evaluated scope in the decision revision', () => {
    const decision = evaluatePrivacyEligibility({
      applicability,
      applicabilityCurrentness: currentness,
      applicabilityScope,
      asOf: '2026-01-02T00:00:00Z',
      consent: null,
      consentCurrentness: null,
      intendedScope: scope,
      legalBasis: { basisRef: 'legal-basis:contract', basisVersion: 'v1', currentness, scope },
      objection: noObjection,
      restriction: noRestriction,
    });
    const changedScope = {
      ...decision,
      evaluatedScope: { ...scope, recipientRefs: ['recipient:archive'] },
    };

    expect(privacyEligibilityDecisionRevision(changedScope)).not.toBe(privacyEligibilityDecisionRevision(decision));
  });

  it('stops a boundary crossing when the consumer operation differs from the evaluated operation', () => {
    const decision = evaluatePrivacyEligibility({
      applicability,
      applicabilityCurrentness: currentness,
      applicabilityScope,
      asOf: '2026-01-02T00:00:00Z',
      consent: null,
      consentCurrentness: null,
      intendedScope: scope,
      legalBasis: { basisRef: 'legal-basis:contract', basisVersion: 'v1', currentness, scope },
      objection: noObjection,
      restriction: noRestriction,
    });
    const result = assessPrivacyEligibilityBoundary({
      boundary: 'before-delete',
      contract: {
        consumerRef: 'consumer:eraser',
        invalidationBehavior: 'STOP_BEFORE_BOUNDARY',
        lastControllableBoundary: 'before-delete',
        operationRef: 'delete',
        recheckRequiredAtBoundary: false,
      },
      decision,
    });

    expect(result).toMatchObject({
      reason: 'operation_not_evaluated_for_consumer',
      result: 'STOPPED',
    });
  });

  it('invalidates a decision when a concurrent privacy revision changes before handoff', () => {
    const decision = evaluatePrivacyEligibility({
      applicability,
      applicabilityCurrentness: currentness,
      applicabilityScope,
      asOf: '2026-01-02T00:00:00Z',
      consent: null,
      consentCurrentness: null,
      intendedScope: scope,
      legalBasis: { basisRef: 'legal-basis:contract', basisVersion: 'v1', currentness, scope },
      objection: noObjection,
      restriction: noRestriction,
    });
    const changed = evaluatePrivacyEligibility({
      applicability,
      applicabilityCurrentness: { ...currentness, revision: 'rev:two' },
      applicabilityScope,
      asOf: '2026-01-03T00:00:00Z',
      consent: null,
      consentCurrentness: null,
      intendedScope: scope,
      legalBasis: {
        basisRef: 'legal-basis:contract',
        basisVersion: 'v1',
        currentness: { ...currentness, revision: 'rev:two' },
        scope,
      },
      objection: noObjection,
      restriction: noRestriction,
    });
    const contract = {
      consumerRef: 'consumer:mailer',
      invalidationBehavior: 'RECHECK_BEFORE_BOUNDARY' as const,
      lastControllableBoundary: 'before-send',
      operationRef: 'send-email',
      recheckRequiredAtBoundary: false,
    };
    expect(
      assessPrivacyEligibilityBoundary({
        boundary: 'before-send',
        contract,
        decision,
        decisionRevision: privacyEligibilityDecisionRevision(decision),
        latest: changed,
      }).result,
    ).toBe('RECHECK_REQUIRED');
  });

  it('invalidates queued work when withdrawal, objection, or intervention currentness wins a race', () => {
    const granted = consentDecision('GRANTED');
    const decision = evaluatePrivacyEligibility({
      applicability,
      applicabilityCurrentness: currentness,
      applicabilityScope,
      asOf: '2026-01-02T00:00:00Z',
      consent: granted,
      consentCurrentness: currentness,
      intendedScope: scope,
      legalBasis: { basisRef: 'legal-basis:consent', basisVersion: 'v1', currentness, scope },
      objection: noObjection,
      restriction: noRestriction,
    });
    const latestInputs = {
      applicability,
      applicabilityCurrentness: currentness,
      applicabilityScope,
      asOf: '2026-01-03T00:00:00Z',
      consentCurrentness: { ...currentness, revision: 'consent:two' },
      intendedScope: scope,
      legalBasis: { basisRef: 'legal-basis:consent', basisVersion: 'v1', currentness, scope },
      restriction: noRestriction,
    };
    const withdrawn = evaluatePrivacyEligibility({
      ...latestInputs,
      consent: consentDecision('WITHDRAWN'),
      objection: noObjection,
    });
    const objected = evaluatePrivacyEligibility({
      ...latestInputs,
      consent: granted,
      objection: {
        currentness: { ...currentness, revision: 'objection:two' },
        objectionRef: 'objection:active',
        scope,
        status: 'ACTIVE',
      },
    });
    const interventionUnknown = evaluatePrivacyEligibility({
      ...latestInputs,
      consent: granted,
      objection: {
        ...noObjection,
        currentness: { ...currentness, authoritative: false, revision: 'objection:unknown' },
      },
    });
    const contract = {
      consumerRef: 'consumer:mailer',
      invalidationBehavior: 'RECHECK_BEFORE_BOUNDARY' as const,
      lastControllableBoundary: 'before-send',
      operationRef: 'send-email',
      recheckRequiredAtBoundary: false,
    };

    expect(decision.outcome).toBe('ALLOWED');
    expect(withdrawn.outcome).toBe('NOT_ALLOWED');
    expect(objected.outcome).toBe('NOT_ALLOWED');
    expect(interventionUnknown.outcome).toBe('INDETERMINATE');
    for (const latest of [withdrawn, objected, interventionUnknown]) {
      expect(assessPrivacyEligibilityBoundary({ boundary: 'before-send', contract, decision, latest }).result).toBe(
        'INVALIDATED',
      );
    }
  });

  it('keeps an indeterminate handoff in reconciliation until the outcome is authoritative', () => {
    const handoff = {
      consumerRef: 'consumer:mailer',
      decisionRevision: 'revision:one',
      handoffRef: 'handoff:one',
      operationRef: 'send-email',
      status: 'PENDING' as const,
    };
    expect(reconcilePrivacyEligibilityHandoff({ handoff, outcome: 'INDETERMINATE' }).status).toBe(
      'RECONCILIATION_REQUIRED',
    );
    expect(reconcilePrivacyEligibilityHandoff({ handoff, outcome: 'SUCCEEDED' }).status).toBe(
      'RECONCILIATION_REQUIRED',
    );
    expect(
      reconcilePrivacyEligibilityHandoff({
        authoritativeDecisionRevision: 'revision:two',
        handoff: { ...handoff, status: 'RECONCILIATION_REQUIRED' },
        outcome: 'SUCCEEDED',
      }).status,
    ).toBe('RECONCILIATION_REQUIRED');
    expect(
      reconcilePrivacyEligibilityHandoff({
        authoritativeDecisionRevision: 'revision:one',
        handoff: { ...handoff, status: 'RECONCILIATION_REQUIRED' },
        outcome: 'SUCCEEDED',
      }).status,
    ).toBe('COMPLETED');
  });

  it('keeps duplicate handoff outcomes terminal and never replays completed work', () => {
    const pending = {
      consumerRef: 'consumer:mailer',
      decisionRevision: 'revision:one',
      handoffRef: 'handoff:duplicate',
      operationRef: 'send-email',
      status: 'PENDING' as const,
    };
    const completed = reconcilePrivacyEligibilityHandoff({
      authoritativeDecisionRevision: 'revision:one',
      handoff: pending,
      outcome: 'SUCCEEDED',
    });
    const duplicate = reconcilePrivacyEligibilityHandoff({ handoff: completed, outcome: 'INDETERMINATE' });

    expect(completed.status).toBe('COMPLETED');
    expect(duplicate).toBe(completed);
  });
});
