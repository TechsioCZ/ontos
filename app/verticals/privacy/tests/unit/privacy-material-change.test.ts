import { describe, expect, it } from 'effect-rstest';

import { assessMaterialPrivacyChange } from '../../shared/domain/privacy-material-change.ts';
import type { MaterialPrivacyChangeInput } from '../../shared/domain/privacy-material-change.ts';

const snapshot = {
  applicabilityKey: 'eu:storefront-a',
  consentRequired: true,
  consentScopeKey: 'subject:1|controller:1|purpose:security:v1',
  controllerRef: 'controller:1',
  dataCategoryRefs: ['email'],
  meaning: 'Protect accounts',
  processingScopeRef: 'scope:account-security',
  purposeRef: 'purpose:security',
  purposeVersionRef: 'purpose:security:v1',
  recipientRefs: ['recipient:core'],
} as const;
const base: MaterialPrivacyChangeInput = {
  affectedPrivacySubjectRefs: ['subject:1'],
  changedAt: '2026-01-01T00:00:00Z',
  changeRef: 'change:1',
  current: snapshot,
  previous: snapshot,
};

describe('Material privacy change', () => {
  it('treats an editorial-only notice revision as not requiring re-notice or consent', () => {
    const result = assessMaterialPrivacyChange(base);
    expect(result.materiality).toBe('EDITORIAL');
    expect(result.outcome).toBe('NO_RENOTICE_REQUIRED');
    expect(result.newConsentDecisionRequired).toBe(false);
  });

  it('requires re-notice and a new explicit consent decision for changed consent scope', () => {
    const result = assessMaterialPrivacyChange({
      ...base,
      current: {
        ...snapshot,
        consentScopeKey: 'subject:1|controller:1|purpose:security:v2',
        purposeVersionRef: 'purpose:security:v2',
      },
    });
    expect(result.materiality).toBe('MATERIAL');
    expect(result.changedDimensions).toContain('PURPOSE_VERSION');
    expect(result.outcome).toBe('RENOTICE_AND_NEW_CONSENT_REQUIRED');
    expect(result.applyBlockedUntilCurrentRequirements).toBe(true);
  });

  it('keeps unrelated subject scope out of automatic re-notice', () => {
    const result = assessMaterialPrivacyChange({
      ...base,
      affectedPrivacySubjectRefs: [],
      current: { ...snapshot, recipientRefs: ['recipient:new'] },
    });
    expect(result.outcome).toBe('OUT_OF_SCOPE');
    expect(result.newConsentDecisionRequired).toBe(false);
  });

  it('preserves historical facts for material changes', () => {
    const result = assessMaterialPrivacyChange({
      ...base,
      current: { ...snapshot, dataCategoryRefs: ['email', 'location'] },
    });
    expect(result.historicalNoticeProvisionPreserved).toBe(true);
    expect(result.historicalConsentDecisionsPreserved).toBe(true);
  });

  it('treats a newly consent-dependent activity as material and blocks it', () => {
    const result = assessMaterialPrivacyChange({
      ...base,
      current: snapshot,
      previous: { ...snapshot, consentRequired: false, consentScopeKey: null },
    });
    expect(result.materiality).toBe('MATERIAL');
    expect(result.outcome).toBe('RENOTICE_AND_NEW_CONSENT_REQUIRED');
    expect(result.newConsentDecisionRequired).toBe(true);
    expect(result.applyBlockedUntilCurrentRequirements).toBe(true);
  });
});
