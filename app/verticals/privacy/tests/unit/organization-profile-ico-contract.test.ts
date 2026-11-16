import { Result, Schema } from 'effect';
import { describe, expect, it } from 'effect-rstest';
import { OrganizationProfileIcoApplicabilityRequestSchema } from '../../shared/apis/organization-profile-ico-applicability.ts';
import {
  OrganizationProfileIcoBusinessFieldSchema,
  OrganizationProfileIcoFieldContractVersion,
  OrganizationProfileIcoOperationSchema,
  PrivacyApplicabilityPolicySchema,
} from '../../shared/domain/privacy-applicability.ts';

const profileRef = {
  moduleId: 'commerce.customer-context',
  resourceId: '72000000-0000-4000-8000-000000000010',
  resourceType: 'commerce.customer-context.counterparty-purchasing-profile',
  tenantId: '72000000-0000-4000-8000-000000000001',
};
const policy = {
  composition: { precedence: 1, strategy: 'EXPLICIT_PRECEDENCE' },
  effectiveFrom: '2026-11-01T00:00:00.000Z',
  effectiveTo: null,
  factPredicates: [
    {
      dimension: 'OWNER_RESOURCE',
      operator: 'EQUALS',
      values: [`commerce.customer-context.counterparty-purchasing-profile:${profileRef.resourceId}`],
    },
    { dimension: 'OWNER_RESOURCE_REVISION', operator: 'EQUALS', values: ['1'] },
    { dimension: 'OWNER_PARTY_KIND', operator: 'EQUALS', values: ['ORGANIZATION'] },
    { dimension: 'CATEGORY', operator: 'EQUALS', values: [OrganizationProfileIcoFieldContractVersion] },
    { dimension: 'INTENDED_USE', operator: 'EQUALS', values: ['customer-profile-ico.read'] },
  ],
  jurisdictionProfile: { profileKey: 'INTERNAL_PROFILE_ICO_ONLY', profileVersion: '1' },
  mandatoryDimensions: ['OWNER_RESOURCE', 'OWNER_RESOURCE_REVISION', 'OWNER_PARTY_KIND', 'CATEGORY', 'INTENDED_USE'],
  nonPersonalApplicability: {
    allowedFields: OrganizationProfileIcoBusinessFieldSchema.literals,
    fieldContractVersion: OrganizationProfileIcoFieldContractVersion,
    holdBehavior: 'NO_ACTIVE_SCOPE_HOLD',
    kind: 'ORGANIZATION_ICO_ONLY',
  },
  policyKey: 'INTERNAL_PROFILE_ICO_ONLY',
  policyVersion: '1',
  scopeKey: 'internal-profile-ico:read',
  sourceEvidenceRefs: ['INTERNAL_EXPLICIT_POLICY_DECISION'],
};

describe('bounded organization profile ICO classification contract', () => {
  it('accepts only the exact ICO operations and finite sanitized fields', () => {
    const decode = Schema.decodeUnknownResult(OrganizationProfileIcoApplicabilityRequestSchema);
    for (const operation of OrganizationProfileIcoOperationSchema.literals) {
      expect(
        Result.isSuccess(decode({ fields: OrganizationProfileIcoBusinessFieldSchema.literals, operation, profileRef })),
      ).toBe(true);
    }
    for (const operation of ['PROFILE_CREATE', 'PRICE_GROUP_ASSIGN', 'customer-profile-source.write']) {
      expect(Result.isFailure(decode({ fields: ['normalizedValue'], operation, profileRef }))).toBe(true);
    }
    for (const field of [
      'actorPrincipalId',
      'reason',
      'provenance.source',
      'contactName',
      'sourceContext',
      'effectId',
    ]) {
      expect(Result.isFailure(decode({ fields: [field], operation: 'customer-profile-ico.read', profileRef }))).toBe(
        true,
      );
    }
    expect(
      Result.isFailure(
        decode({ fields: ['normalizedValue', 'normalizedValue'], operation: 'customer-profile-ico.read', profileRef }),
      ),
    ).toBe(true);
  });
  it('requires explicit organization, profile version and ICO operation policy facts without extending Party inventory policy', () => {
    const decode = Schema.decodeUnknownResult(PrivacyApplicabilityPolicySchema);
    expect(Result.isSuccess(decode(policy))).toBe(true);
    const replaceUse = (value: string) =>
      policy.factPredicates.map((predicate) =>
        predicate.dimension === 'INTENDED_USE' ? { ...predicate, values: [value] } : predicate,
      );
    for (const value of ['PROFILE_CREATE', 'PRICE_GROUP_ASSIGN', 'party-ico-legacy-inventory.read']) {
      expect(Result.isFailure(decode({ ...policy, factPredicates: replaceUse(value) }))).toBe(true);
    }
    expect(
      Result.isFailure(
        decode({
          ...policy,
          nonPersonalApplicability: { ...policy.nonPersonalApplicability, allowedFields: ['reason'] },
        }),
      ),
    ).toBe(true);
    expect(Result.isFailure(decode({ ...policy, mandatoryDimensions: ['CATEGORY', 'INTENDED_USE'] }))).toBe(true);
  });
});
