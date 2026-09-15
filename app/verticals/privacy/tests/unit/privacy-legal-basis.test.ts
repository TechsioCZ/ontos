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
    authority: {
      controllerRef: {
        moduleId: 'privacy.core',
        resourceId: 'controller:acme',
        resourceType: 'privacy.core.controller',
        tenantId: '00000000-0000-4000-8000-000000000001',
      },
      legalEntityId: '00000000-0000-4000-8000-000000000002',
      purposeRef: {
        moduleId: 'privacy.core',
        resourceId: 'purpose:account',
        resourceType: 'privacy.core.processing-purpose',
        tenantId: '00000000-0000-4000-8000-000000000001',
      },
      purposeVersionRef: {
        moduleId: 'privacy.core',
        resourceId: '00000000-0000-4000-8000-000000000010',
        resourceType: 'privacy.core.processing-purpose-version',
        tenantId: '00000000-0000-4000-8000-000000000001',
      },
      tenantId: '00000000-0000-4000-8000-000000000001',
    },
    evaluatedAt: '2026-01-01T00:00:00Z',
    evaluatedScope: {
      facts: [
        { dimension: 'CONTROLLER_SCOPE', value: 'controller:acme' },
        { dimension: 'PROCESSING_PURPOSE', value: 'purpose:account' },
        { dimension: 'PROCESSING_PURPOSE_VERSION', value: '00000000-0000-4000-8000-000000000010' },
      ],
      operation: 'ACCOUNT_CREATE',
      processingScopeRef: { scopeId: 'scope:account', scopeType: 'privacy.processing-scope' },
    },
    evidenceRefs: ['evidence:applicability'],
    outcome: 'APPLICABLE',
    policyIdentities: [{ policyKey: 'policy:legal-basis', policyVersion: '1' }],
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
    operation: 'ACCOUNT_CREATE',
    processingScopeRef: { scopeId: 'scope:account', scopeType: 'privacy.processing-scope' },
    purposeRef: {
      moduleId: 'privacy.core',
      resourceId: 'purpose:account',
      resourceType: 'privacy.core.processing-purpose',
      tenantId: '00000000-0000-4000-8000-000000000001',
    },
    purposeVersionId: '00000000-0000-4000-8000-000000000010',
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

  it('rejects legacy or foreign Applicability authority for a new Legal Basis Assignment', () => {
    const { authority, ...legacyDecision } = decoded.applicabilityDecision;
    expect(validatePrivacyLegalBasisAssignment({ ...decoded, applicabilityDecision: legacyDecision }).valid).toBe(
      false,
    );
    if (authority === undefined) {
      throw new Error('Test fixture must include authoritative Applicability identity');
    }
    expect(
      validatePrivacyLegalBasisAssignment({
        ...decoded,
        applicabilityDecision: {
          ...decoded.applicabilityDecision,
          authority: {
            ...authority,
            tenantId: '00000000-0000-4000-8000-000000000099',
          },
        },
      }).valid,
    ).toBe(false);
  });

  it('requires exact applicability policy provenance', () => {
    expect(
      validatePrivacyLegalBasisAssignment({
        ...decoded,
        applicabilityDecision: { ...decoded.applicabilityDecision, policyIdentities: [] },
      }),
    ).toEqual({
      errors: ['Legal Basis Assignment policy provenance must match the Applicability Decision'],
      valid: false,
    });
    expect(
      validatePrivacyLegalBasisAssignment({
        ...decoded,
        applicabilityDecision: {
          ...decoded.applicabilityDecision,
          policyIdentities: decoded.applicabilityDecision.policyIdentities.map((identity) => ({
            ...identity,
            policyVersion: '2',
          })),
        },
      }),
    ).toEqual({
      errors: ['Legal Basis Assignment policy provenance must match the Applicability Decision'],
      valid: false,
    });
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

  it('rejects applicability for a different operation, purpose, or processing-scope type', () => {
    expect(
      validatePrivacyLegalBasisAssignment({
        ...decoded,
        scope: { ...decoded.scope, operation: 'ACCOUNT_DELETE' },
      }).valid,
    ).toBe(false);
    expect(
      validatePrivacyLegalBasisAssignment({
        ...decoded,
        scope: {
          ...decoded.scope,
          purposeVersionId: 'purpose-version:other',
        },
      }).valid,
    ).toBe(false);
    expect(
      validatePrivacyLegalBasisAssignment({
        ...decoded,
        applicabilityDecision: {
          ...decoded.applicabilityDecision,
          evaluatedScope: {
            ...decoded.applicabilityDecision.evaluatedScope,
            processingScopeRef: { scopeId: 'scope:other', scopeType: 'privacy.processing-scope' },
          },
        },
      }).valid,
    ).toBe(false);
  });

  it('rejects an applicability decision evaluated outside the assignment period', () => {
    expect(
      validatePrivacyLegalBasisAssignment({
        ...decoded,
        effectiveFrom: '2026-02-01T00:00:00Z',
      }).valid,
    ).toBe(false);
  });
});
