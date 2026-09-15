import { describe, expect, it } from 'effect-rstest';

import {
  ConsentScopeSchema,
  isChannelNeutralConsentScope,
  validateConsentScope,
} from '../../shared/domain/privacy-consent-scope.ts';
import type { ConsentScope } from '../../shared/domain/privacy-consent-scope.ts';

const purposeVersion = {
  effectiveFrom: '2026-01-01T00:00:00Z',
  effectiveTo: null,
  meaning: 'Send account security alerts',
  recordedAt: '2026-01-01T00:00:00Z',
  versionId: '11111111-1111-4111-8111-111111111111',
  versionNumber: 1,
} as const;
const scope: ConsentScope = {
  controllerRef: 'controller:one',
  materialDimensions: [],
  privacySubjectRef: {
    moduleId: 'privacy.core',
    resourceId: 'subject:one',
    resourceType: 'privacy.core.privacy-subject',
    tenantId: '00000000-0000-4000-8000-000000000000',
  },
  processingPurposeRef: {
    moduleId: 'privacy.core',
    resourceId: 'purpose:security',
    resourceType: 'privacy.core.processing-purpose',
    tenantId: '00000000-0000-4000-8000-000000000000',
  },
  purposeMeaning: purposeVersion.meaning,
  purposeVersionRef: purposeVersion.versionId,
  scopeRef: 'scope:security',
};

describe('Consent Scope', () => {
  it('requires subject, controller, precise purpose meaning, and pinned version', () => {
    expect(validateConsentScope({ purposeVersion, scope })).toEqual({ errors: [], valid: true });
    expect(ConsentScopeSchema).toBeDefined();
  });

  it('keeps EMAIL and SMS independently addressable', () => {
    const email = {
      ...scope,
      materialDimensions: [{ kind: 'COMMUNICATION_CHANNEL' as const, value: 'EMAIL' as const }],
    };
    const sms = { ...scope, materialDimensions: [{ kind: 'COMMUNICATION_CHANNEL' as const, value: 'SMS' as const }] };
    expect(email.materialDimensions).not.toEqual(sms.materialDimensions);
    expect(validateConsentScope({ requiredDimensions: ['COMMUNICATION_CHANNEL'], scope: email }).valid).toBe(true);
  });

  it('does not turn a missing material dimension into a wildcard', () => {
    const result = validateConsentScope({ requiredDimensions: ['SITE'], scope });
    expect(result.valid).toBe(false);
    expect(result.errors[0]).toContain('SITE');
  });

  it('represents channel-neutral consent with no invented channel', () => {
    expect(isChannelNeutralConsentScope(scope)).toBe(true);
    expect(scope.materialDimensions).toEqual([]);
  });

  it('rejects a rewritten purpose version or meaning', () => {
    expect(
      validateConsentScope({
        purposeVersion,
        scope: { ...scope, purposeVersionRef: '22222222-2222-4222-8222-222222222222' },
      }).valid,
    ).toBe(false);
    expect(
      validateConsentScope({ purposeVersion, scope: { ...scope, purposeMeaning: 'A broader purpose' } }).valid,
    ).toBe(false);
  });
});
