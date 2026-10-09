import { Option, Schema } from 'effect';
import { describe, expect, it } from 'effect-rstest';

import {
  evaluatePrivacyMinimization,
  isPrivacyMinimizationDecisionForScope,
} from '../../shared/domain/privacy-minimization.ts';
import { PrivacyIsoTimestampSchema } from '../../shared/domain/privacy-subject.ts';

const scope = {
  controllerRef: 'controller:acme',
  dataCategoryRefs: ['category:email'],
  operation: 'send-account-alert',
  processingScopeRef: { scopeId: 'scope:alerts', scopeType: 'privacy.processing-scope' as const },
  purposeRef: 'purpose:account-alerts',
  purposeVersionId: 'purpose-version:1',
  recipientRefs: ['recipient:mail-provider'],
  subjectRef: {
    moduleId: 'privacy.core' as const,
    resourceId: 'subject:acme',
    resourceType: 'privacy.core.privacy-subject' as const,
    tenantId: '00000000-0000-4000-8000-000000000001',
  },
};

const base = {
  asOf: Schema.decodeUnknownSync(PrivacyIsoTimestampSchema)('2026-09-14T10:00:00Z'),
  decisionRef: 'decision:minimization:1',
  intendedScope: scope,
  legalBasis: { basisRef: 'basis:contract', basisVersion: 'basis:v1', current: true },
  policy: { allowedDataCategoryRefs: ['category:email'], policyRef: 'policy:minimization', policyVersion: '1' },
  requestedDataCategoryRefs: ['category:email'],
  sourceActivityRef: 'activity:account-alerts',
};

describe('privacy minimization', () => {
  it('allows only an explicitly declared exact scope with a current legal basis', () => {
    const decision = evaluatePrivacyMinimization(base);

    expect(decision.outcome).toBe('ALLOWED');
    expect(decision.evaluatedScope.purposeRef).toBe('purpose:account-alerts');
    expect(Option.getOrNull(decision.sourceActivityRef)).toBe('activity:account-alerts');
    expect(isPrivacyMinimizationDecisionForScope(decision, scope)).toBe(true);
  });

  it('does not reuse a source activity when the requested category exceeds the approved minimum', () => {
    const decision = evaluatePrivacyMinimization({
      ...base,
      requestedDataCategoryRefs: ['category:email', 'category:phone'],
    });

    expect(decision.outcome).toBe('NOT_ALLOWED');
    expect(decision.reasonCodes).toContain('data_category_exceeds_declared_minimum');
    expect(Option.getOrNull(decision.sourceActivityRef)).toBe('activity:account-alerts');
  });

  it('returns indeterminate when legal-basis currentness is unavailable or false', () => {
    expect(evaluatePrivacyMinimization({ ...base, legalBasis: null }).outcome).toBe('INDETERMINATE');
    expect(evaluatePrivacyMinimization({ ...base, legalBasis: { ...base.legalBasis, current: false } }).outcome).toBe(
      'INDETERMINATE',
    );
  });

  it('rejects applying a decision to a different purpose or scope', () => {
    const decision = evaluatePrivacyMinimization(base);

    expect(isPrivacyMinimizationDecisionForScope(decision, { ...scope, purposeRef: 'purpose:marketing' })).toBe(false);
    expect(isPrivacyMinimizationDecisionForScope(decision, { ...scope, dataCategoryRefs: ['category:phone'] })).toBe(
      false,
    );
  });
});
