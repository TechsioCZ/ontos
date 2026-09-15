import { Schema } from 'effect';
import { describe, expect, it } from 'effect-rstest';

import {
  PrivacyLegalBasisAssignmentSchema,
  resolveCurrentPrivacyLegalBasis,
  validatePrivacyLegalBasisAssignment,
} from '../../shared/domain/privacy-legal-basis.ts';

const assignment = {
  actor: { principalId: '00000000-0000-4000-8000-000000000002', tenantId: '00000000-0000-4000-8000-000000000001' },
  applicabilityDecision: {
    evaluatedAt: '2026-01-01T00:00:00Z',
    evaluatedScope: {
      facts: [{ dimension: 'CONTROLLER_SCOPE', value: 'controller:acme' }],
      operation: 'ACCOUNT_CREATE',
      processingScopeRef: { scopeId: 'scope:account', scopeType: 'privacy.processing-scope' },
    },
    evidenceRefs: ['evidence:applicability'],
    outcome: 'APPLICABLE',
    policyIdentities: [],
    proposedActivity: true,
    reasonCodes: ['explicit_policy_match'],
    responsibilityAssignmentRefs: [],
  },
  assignmentRef: {
    moduleId: 'privacy.core',
    resourceId: 'assignment:account-v1',
    resourceType: 'privacy.core.legal-basis-assignment',
    tenantId: '00000000-0000-4000-8000-000000000001',
  },
  basis: 'CONTRACT',
  basisVersion: 'governance:v1',
  decision: 'APPROVED',
  effectiveFrom: '2026-01-01T00:00:00Z',
  effectiveTo: null,
  provenance: {
    decisionEvidenceRefs: ['evidence:legal-basis'],
    policyRef: 'policy:legal-basis',
    policyVersion: '1',
    reason: 'Account service governance decision',
    recordedAt: '2026-01-01T00:00:00Z',
  },
  scope: {
    controllerRef: 'controller:acme',
    processingScopeRef: { scopeId: 'scope:account', scopeType: 'privacy.processing-scope' },
    purposeRef: {
      moduleId: 'privacy.core',
      resourceId: 'purpose:account',
      resourceType: 'privacy.core.processing-purpose',
      tenantId: '00000000-0000-4000-8000-000000000001',
    },
    purposeVersionId: 'purpose-version:1',
  },
} as const;

const decoded = Schema.decodeUnknownSync(PrivacyLegalBasisAssignmentSchema)(assignment);

describe('privacy legal basis assignments', () => {
  it('requires an explicit basis, exact Controller scope, applicability, period, and provenance', () => {
    expect(validatePrivacyLegalBasisAssignment(decoded)).toEqual({ valid: true });
    expect(decoded.basis).toBe('CONTRACT');
    expect(decoded.scope.controllerRef).toBe('controller:acme');
  });

  it('fails closed when applicability is unresolved', () => {
    const unresolved = {
      ...decoded,
      applicabilityDecision: { ...decoded.applicabilityDecision, outcome: 'UNRESOLVED' as const },
    };
    expect(validatePrivacyLegalBasisAssignment(unresolved).valid).toBe(false);
  });

  it('resolves one current assignment and never falls back to another basis', () => {
    expect(resolveCurrentPrivacyLegalBasis([decoded], decoded.scope, '2026-06-01T00:00:00Z').outcome).toBe('CURRENT');
    expect(resolveCurrentPrivacyLegalBasis([], decoded.scope, '2026-06-01T00:00:00Z').outcome).toBe('ABSENT');
  });

  it('reports overlapping current decisions as an explicit conflict', () => {
    const second = {
      ...decoded,
      assignmentRef: { ...decoded.assignmentRef, resourceId: 'assignment:account-v2' },
      basis: 'LEGITIMATE_INTERESTS' as const,
    };
    const result = resolveCurrentPrivacyLegalBasis([decoded, second], decoded.scope, '2026-06-01T00:00:00Z');
    expect(result.outcome).toBe('CONFLICT');
  });

  it('does not treat consent as a fallback for an unrelated Controller scope', () => {
    const consent = {
      ...decoded,
      basis: 'CONSENT' as const,
      scope: { ...decoded.scope, controllerRef: 'controller:other' },
    };
    expect(resolveCurrentPrivacyLegalBasis([consent], decoded.scope, '2026-06-01T00:00:00Z').outcome).toBe('ABSENT');
  });
});
