import { describe, expect, it } from 'effect-rstest';
import { Schema } from 'effect';

import {
  PrivacyApplicabilityAuthoritySchema,
  PrivacyApplicabilityPolicySchema,
  resolvePrivacyApplicability,
} from '../../shared/domain/privacy-applicability.ts';
import { selectPrivacyNoticeVersion } from '../../shared/domain/privacy-notice-selection.ts';
import type { PrivacyNoticeVersion } from '../../shared/domain/privacy-notice-version.ts';

const scope = {
  facts: [
    { dimension: 'CONTROLLER_SCOPE' as const, value: 'controller-1' },
    { dimension: 'PROCESSING_PURPOSE' as const, value: 'account-service' },
  ],
  operation: 'account-creation',
  processingScopeRef: { scopeId: 'scope-1', scopeType: 'privacy.processing-scope' as const },
};
const policy = Schema.decodeUnknownSync(PrivacyApplicabilityPolicySchema)({
  composition: { precedence: 1, strategy: 'EXPLICIT_PRECEDENCE' },
  effectiveFrom: '2025-01-01T00:00:00Z',
  effectiveTo: null,
  factPredicates: [
    { dimension: 'CONTROLLER_SCOPE', operator: 'EQUALS', values: ['controller-1'] },
    { dimension: 'PROCESSING_PURPOSE', operator: 'EQUALS', values: ['account-service'] },
  ],
  jurisdictionProfile: {
    profileKey: 'privacy.profile.eu-eea-gdpr-baseline',
    profileVersion: '1',
  },
  mandatoryDimensions: ['CONTROLLER_SCOPE', 'PROCESSING_PURPOSE'],
  policyKey: 'privacy.applicability.account',
  policyVersion: '1',
  scopeKey: 'privacy.processing-scope:scope-1:account-creation',
  sourceEvidenceRefs: ['evidence-1'],
});
const authority = Schema.decodeUnknownSync(PrivacyApplicabilityAuthoritySchema)({
  controllerRef: {
    moduleId: 'privacy.core',
    resourceId: 'controller-1',
    resourceType: 'privacy.core.controller',
    tenantId: '00000000-0000-4000-8000-000000000001',
  },
  legalEntityId: '00000000-0000-4000-8000-000000000002',
  purposeRef: {
    moduleId: 'privacy.core',
    resourceId: 'account-service',
    resourceType: 'privacy.core.processing-purpose',
    tenantId: '00000000-0000-4000-8000-000000000001',
  },
  purposeVersionRef: {
    moduleId: 'privacy.core',
    resourceId: '00000000-0000-4000-8000-000000000003',
    resourceType: 'privacy.core.processing-purpose-version',
    tenantId: '00000000-0000-4000-8000-000000000001',
  },
  tenantId: '00000000-0000-4000-8000-000000000001',
});
const decision = resolvePrivacyApplicability({
  authority,
  evaluatedAt: '2026-01-01T00:00:00Z',
  policies: [policy],
  proposedActivity: true,
  scope,
});

const notice = (language: string, versionId: string, effectiveFrom = '2026-01-01T00:00:00Z'): PrivacyNoticeVersion => ({
  applicableScope: scope,
  contentIdentity: `sha256:${versionId}`,
  effectiveFrom,
  effectiveTo: null,
  evidenceArtifactRef: null,
  language,
  noticeRef: {
    moduleId: 'privacy.core',
    resourceId: `notice-${versionId}`,
    resourceType: 'privacy.core.privacy-notice-version',
    tenantId: '00000000-0000-4000-8000-000000000001',
  },
  recordedAt: '2026-01-01T00:00:00Z',
  versionId,
  versionNumber: 1,
  wording: 'Notice',
});

describe('Privacy Notice selection', () => {
  it('selects the exact requested language within the approved scope and period', () => {
    const result = selectPrivacyNoticeVersion({
      at: '2026-02-01T00:00:00Z',
      decision,
      notices: [notice('en-US', '00000000-0000-4000-8000-000000000001')],
      requestedLanguage: 'en-US',
    });
    expect(result.kind).toBe('SELECTED');
    if (result.kind === 'SELECTED') {
      expect(result.providedLanguage).toBe('en-US');
    }
  });

  it('uses only an explicit fallback and preserves the provided language', () => {
    const result = selectPrivacyNoticeVersion({
      at: '2026-02-01T00:00:00Z',
      decision,
      fallbackLanguages: ['cs-CZ'],
      notices: [notice('cs-CZ', '00000000-0000-4000-8000-000000000002')],
      requestedLanguage: 'en-US',
    });
    expect(result.kind).toBe('SELECTED');
    if (result.kind === 'SELECTED') {
      expect(result.providedLanguage).toBe('cs-CZ');
    }
    expect(
      selectPrivacyNoticeVersion({
        at: '2026-02-01T00:00:00Z',
        decision,
        notices: [notice('cs-CZ', '00000000-0000-4000-8000-000000000003')],
        requestedLanguage: 'en-US',
      }).kind,
    ).toBe('UNCOVERED');
  });

  it('rejects a conflicting explicit fallback configuration', () => {
    const result = selectPrivacyNoticeVersion({
      at: '2026-02-01T00:00:00Z',
      decision,
      fallbackLanguages: ['cs-CZ', 'cs-CZ'],
      notices: [notice('cs-CZ', '00000000-0000-4000-8000-000000000006')],
      requestedLanguage: 'en-US',
    });
    expect(result).toEqual({ kind: 'INDETERMINATE', reason: 'INVALID_FALLBACK_CONFIGURATION' });
  });

  it('rejects zero, multiple, out-of-period, and non-approved matches', () => {
    const duplicate = notice('en-US', '00000000-0000-4000-8000-000000000004');
    expect(
      selectPrivacyNoticeVersion({
        at: '2026-02-01T00:00:00Z',
        decision,
        notices: [duplicate, { ...duplicate, versionId: '00000000-0000-4000-8000-000000000005' }],
        requestedLanguage: 'en-US',
      }).kind,
    ).toBe('INDETERMINATE');
    expect(
      selectPrivacyNoticeVersion({
        at: '2025-02-01T00:00:00Z',
        decision,
        notices: [duplicate],
        requestedLanguage: 'en-US',
      }).kind,
    ).toBe('UNCOVERED');
    expect(
      selectPrivacyNoticeVersion({
        at: '2026-02-01T00:00:00Z',
        decision: { ...decision, outcome: 'UNRESOLVED' },
        notices: [duplicate],
        requestedLanguage: 'en-US',
      }).kind,
    ).toBe('INDETERMINATE');
  });
});
