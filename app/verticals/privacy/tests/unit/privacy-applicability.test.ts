import { Schema } from 'effect';
import { describe, expect, it } from 'effect-rstest';

import {
  PrivacyApplicabilityPolicySchema,
  PrivacyApplicabilityAuthoritySchema,
  PrivacyApplicabilityScopeSchema,
  resolvePrivacyApplicability,
} from '../../shared/domain/privacy-applicability.ts';
import { RecordPrivacyApplicabilityPayloadSchema } from '../../shared/actions/record-privacy-applicability.ts';
import { PrivacyIsoTimestampSchema } from '../../shared/domain/privacy-subject.ts';

const scope = {
  facts: [
    { dimension: 'CONTROLLER_SCOPE', value: 'assignment:controller-a' },
    { dimension: 'PROCESSING_PURPOSE', value: 'purpose:account-service' },
    { dimension: 'PROCESSING_PURPOSE_VERSION', value: '00000000-0000-4000-8000-000000000010' },
  ],
  operation: 'ACCOUNT_CREATE',
  processingScopeRef: { scopeId: 'account', scopeType: 'privacy.processing-scope' },
} as const;

const policy = {
  composition: { precedence: 10, strategy: 'EXPLICIT_PRECEDENCE' },
  effectiveFrom: '2026-01-01T00:00:00Z',
  effectiveTo: null,
  factPredicates: [
    { dimension: 'CONTROLLER_SCOPE', operator: 'EQUALS', values: ['assignment:controller-a'] },
    { dimension: 'PROCESSING_PURPOSE', operator: 'EQUALS', values: ['purpose:account-service'] },
    {
      dimension: 'PROCESSING_PURPOSE_VERSION',
      operator: 'EQUALS',
      values: ['00000000-0000-4000-8000-000000000010'],
    },
  ],
  jurisdictionProfile: {
    profileKey: 'privacy.profile.eu-eea-gdpr-baseline',
    profileVersion: '1',
  },
  mandatoryDimensions: ['CONTROLLER_SCOPE', 'PROCESSING_PURPOSE', 'PROCESSING_PURPOSE_VERSION'],
  policyKey: 'privacy.applicability.eu-eea.v1',
  policyVersion: '1',
  scopeKey: 'privacy.processing-scope:account:ACCOUNT_CREATE',
  sourceEvidenceRefs: ['evidence:policy-1'],
} as const;

const decodedPolicy = Schema.decodeUnknownSync(PrivacyApplicabilityPolicySchema)(policy);
const decodedScope = Schema.decodeUnknownSync(PrivacyApplicabilityScopeSchema)(scope);
const evaluatedAt = Schema.decodeUnknownSync(PrivacyIsoTimestampSchema)('2026-09-14T10:00:00Z');
const authority = Schema.decodeUnknownSync(PrivacyApplicabilityAuthoritySchema)({
  controllerRef: {
    moduleId: 'privacy.core',
    resourceId: 'assignment:controller-a',
    resourceType: 'privacy.core.controller',
    tenantId: '00000000-0000-4000-8000-000000000001',
  },
  legalEntityId: '00000000-0000-4000-8000-000000000002',
  purposeRef: {
    moduleId: 'privacy.core',
    resourceId: 'purpose:account-service',
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
});
const input = { evaluatedAt, policies: [decodedPolicy], proposedActivity: true, scope: decodedScope };
const trustedInput = { ...input, authority };

describe('privacy applicability contracts', () => {
  it('does not expose caller-declared business facts in the public applicability request', () => {
    const payload = Schema.decodeUnknownSync(RecordPrivacyApplicabilityPayloadSchema)({
      decisionId: 'decision:caller-facts',
      proposedActivity: true,
      responsibilityAssignmentRefs: [],
      scope: {
        facts: [{ dimension: 'JURISDICTION', value: 'caller-controlled' }],
        operation: 'ACCOUNT_CREATE',
        processingScopeRef: { scopeId: 'account', scopeType: 'privacy.processing-scope' },
      },
    });
    expect(payload.scope).not.toHaveProperty('facts');
  });

  it('allows an explicitly scoped proposed activity without requiring ALLOWED processing', () => {
    const result = resolvePrivacyApplicability(trustedInput);
    expect(result.outcome).toBe('APPLICABLE');
    expect(result.proposedActivity).toBe(true);
    expect(result.evaluatedScope).toEqual(scope);
    expect(result.policyIdentities).toHaveLength(1);
  });

  it('fails closed when caller-declared facts have no business-fact authority', () => {
    const result = resolvePrivacyApplicability(input);
    expect(result.outcome).toBe('UNRESOLVED');
    expect(result.reasonCodes).toEqual(['authority_missing']);
  });

  it('fails closed for missing mandatory facts', () => {
    const jurisdictionPolicy = Schema.decodeUnknownSync(PrivacyApplicabilityPolicySchema)({
      ...policy,
      factPredicates: [...policy.factPredicates, { dimension: 'JURISDICTION', operator: 'EQUALS', values: ['EU'] }],
      mandatoryDimensions: [...policy.mandatoryDimensions, 'JURISDICTION'],
      policyKey: 'privacy.applicability.account-jurisdiction.v1',
    });
    const result = resolvePrivacyApplicability({
      ...trustedInput,
      policies: [jurisdictionPolicy],
    });
    expect(result.outcome).toBe('UNRESOLVED');
    expect(result.reasonCodes).toContain('mandatory_input_missing');
  });

  it('fails closed when a fact value does not satisfy the selected policy predicate', () => {
    const changed = resolvePrivacyApplicability({
      ...trustedInput,
      authority: {
        ...authority,
        purposeRef: { ...authority.purposeRef, resourceId: 'purpose:other' },
      },
      scope: {
        ...decodedScope,
        facts: decodedScope.facts.filter((fact) => fact.dimension !== 'PROCESSING_PURPOSE'),
      },
    });
    expect(changed.outcome).toBe('UNRESOLVED');
    expect(changed.reasonCodes).toContain('policy_predicate_mismatch');
  });

  it('fails closed for future and expired policy effective periods', () => {
    const future = { ...decodedPolicy, effectiveFrom: '2027-01-01T00:00:00Z' };
    expect(resolvePrivacyApplicability({ ...trustedInput, policies: [future] }).reasonCodes).toContain(
      'policy_not_effective',
    );

    const expired = { ...decodedPolicy, effectiveTo: '2026-01-01T00:00:00Z' };
    expect(resolvePrivacyApplicability({ ...trustedInput, policies: [expired] }).reasonCodes).toContain(
      'policy_not_effective',
    );
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
    expect(result.reasonCodes).toContain('authority_missing');
  });

  it('keeps equal-precedence applicable policies unresolved as an explicit conflict', () => {
    const second = decodedPolicy;
    const result = resolvePrivacyApplicability({ ...trustedInput, policies: [decodedPolicy, second] });
    expect(result.outcome).toBe('CONFLICT');
    expect(result.reasonCodes).toContain('policy_composition_conflict');
  });

  it('does not fall back to a lower-precedence policy when the selected policy does not match', () => {
    const stricter = Schema.decodeUnknownSync(PrivacyApplicabilityPolicySchema)({
      ...policy,
      composition: { precedence: 20, strategy: 'EXPLICIT_PRECEDENCE' },
      factPredicates: policy.factPredicates.map((predicate) =>
        predicate.dimension === 'PROCESSING_PURPOSE' ? { ...predicate, values: ['purpose:other'] } : predicate,
      ),
      policyKey: 'privacy.applicability.account-strict.v1',
    });
    const result = resolvePrivacyApplicability({ ...trustedInput, policies: [decodedPolicy, stricter] });
    expect(result.outcome).toBe('UNRESOLVED');
    expect(result.reasonCodes).toContain('policy_predicate_mismatch');
    expect(result.policyIdentities).toHaveLength(1);
  });

  it('returns a conflict when one declared scope contains contradictory facts', () => {
    const result = resolvePrivacyApplicability({
      ...trustedInput,
      scope: {
        ...decodedScope,
        facts: [...decodedScope.facts, { dimension: 'CONTROLLER_SCOPE', value: 'assignment:controller-b' }],
      },
    });
    expect(result.outcome).toBe('CONFLICT');
    expect(result.reasonCodes).toContain('declared_fact_conflict');
  });

  it('does not let caller fact aliases override tenant-bound typed authority', () => {
    const conflictingAuthority = Schema.decodeUnknownSync(PrivacyApplicabilityAuthoritySchema)({
      controllerRef: {
        moduleId: 'privacy.core',
        resourceId: 'assignment:controller-authoritative',
        resourceType: 'privacy.core.controller',
        tenantId: '00000000-0000-4000-8000-000000000001',
      },
      legalEntityId: '00000000-0000-4000-8000-000000000002',
      purposeRef: {
        moduleId: 'privacy.core',
        resourceId: 'purpose:authoritative',
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
    });
    const result = resolvePrivacyApplicability({ ...trustedInput, authority: conflictingAuthority });
    expect(result.outcome).toBe('CONFLICT');
    expect(result.reasonCodes).toContain('declared_fact_conflict');
  });

  it('validates policy identity and version as persisted decision inputs', () => {
    expect(Schema.decodeUnknownSync(PrivacyApplicabilityPolicySchema)(policy).policyVersion).toBe('1');
    expect(Schema.decodeUnknownSync(PrivacyApplicabilityPolicySchema)(policy).jurisdictionProfile).toEqual({
      profileKey: 'privacy.profile.eu-eea-gdpr-baseline',
      profileVersion: '1',
    });
  });
});
