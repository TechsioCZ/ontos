import { Schema } from 'effect';
import { describe, expect, it } from 'effect-rstest';

import {
  PrivacyApplicabilityPolicySchema,
  PrivacyApplicabilityScopeSchema,
  resolvePrivacyApplicability,
} from '../../shared/domain/privacy-applicability.ts';
import { PrivacyIsoTimestampSchema } from '../../shared/domain/privacy-subject.ts';

const scope = {
  facts: [
    { dimension: 'CONTROLLER_SCOPE', value: 'assignment:controller-a' },
    { dimension: 'PROCESSING_PURPOSE', value: 'purpose:account-service' },
    { dimension: 'PROCESSING_PURPOSE_VERSION', value: 'v1' },
  ],
  operation: 'ACCOUNT_CREATE',
  processingScopeRef: { scopeId: 'account', scopeType: 'privacy.processing-scope' },
} as const;

const policy = {
  composition: { precedence: 10, strategy: 'EXPLICIT_PRECEDENCE' },
  effectiveFrom: '2026-01-01T00:00:00Z',
  effectiveTo: null,
  jurisdictionProfile: 'EU_EEA_GDPR_BASELINE',
  mandatoryDimensions: ['CONTROLLER_SCOPE', 'PROCESSING_PURPOSE', 'PROCESSING_PURPOSE_VERSION'],
  policyKey: 'privacy.applicability.eu-eea.v1',
  policyVersion: '1',
  scopeKey: 'privacy.processing-scope:account:ACCOUNT_CREATE',
  sourceEvidenceRefs: ['evidence:policy-1'],
} as const;

const decodedPolicy = Schema.decodeUnknownSync(PrivacyApplicabilityPolicySchema)(policy);
const decodedScope = Schema.decodeUnknownSync(PrivacyApplicabilityScopeSchema)(scope);
const evaluatedAt = Schema.decodeUnknownSync(PrivacyIsoTimestampSchema)('2026-09-14T10:00:00Z');
const input = { evaluatedAt, policies: [decodedPolicy], proposedActivity: true, scope: decodedScope };

describe('privacy applicability contracts', () => {
  it('allows an explicitly scoped proposed activity without requiring ALLOWED processing', () => {
    const result = resolvePrivacyApplicability(input);
    expect(result.outcome).toBe('APPLICABLE');
    expect(result.proposedActivity).toBe(true);
    expect(result.evaluatedScope).toEqual(scope);
    expect(result.policyIdentities).toHaveLength(1);
  });

  it('fails closed for missing mandatory facts', () => {
    const result = resolvePrivacyApplicability({
      ...input,
      scope: { ...decodedScope, facts: decodedScope.facts.slice(0, 2) },
    });
    expect(result.outcome).toBe('UNRESOLVED');
    expect(result.reasonCodes).toContain('mandatory_input_missing');
  });

  it('does not infer Controller or jurisdiction from a tenant-like fact', () => {
    const result = resolvePrivacyApplicability({
      ...input,
      scope: {
        ...decodedScope,
        facts: [{ dimension: 'TENANT', value: 'tenant:one' }],
      },
    });
    expect(result.outcome).toBe('UNRESOLVED');
    expect(result.reasonCodes).toContain('mandatory_input_missing');
  });

  it('keeps equal-precedence applicable policies unresolved as an explicit conflict', () => {
    const second = decodedPolicy;
    const result = resolvePrivacyApplicability({ ...input, policies: [decodedPolicy, second] });
    expect(result.outcome).toBe('CONFLICT');
    expect(result.reasonCodes).toContain('policy_composition_conflict');
  });

  it('returns a conflict when one declared scope contains contradictory facts', () => {
    const result = resolvePrivacyApplicability({
      ...input,
      scope: {
        ...decodedScope,
        facts: [...decodedScope.facts, { dimension: 'CONTROLLER_SCOPE', value: 'assignment:controller-b' }],
      },
    });
    expect(result.outcome).toBe('CONFLICT');
    expect(result.reasonCodes).toContain('declared_fact_conflict');
  });

  it('validates policy identity and version as persisted decision inputs', () => {
    expect(Schema.decodeUnknownSync(PrivacyApplicabilityPolicySchema)(policy).policyVersion).toBe('1');
  });
});
