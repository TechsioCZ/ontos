import { Option, Schema } from 'effect';
import { describe, expect, it } from 'effect-rstest';

import {
  appliesPrivacyRetentionRuleToExistingContent,
  validatePrivacyRetentionRule,
} from '../../shared/domain/privacy-retention-rule.ts';
import { PrivacyIsoTimestampSchema } from '../../shared/domain/privacy-subject.ts';

const effectiveFrom = Schema.decodeUnknownSync(PrivacyIsoTimestampSchema)('2026-01-01T00:00:00Z');
const base = {
  authorityRef: 'authority:legal',
  businessStartRef: 'event:account-closed',
  contentScopeRef: 'contact.email',
  effectiveFrom,
  retentionWindow: { durationDays: 730, kind: 'DURATION' as const },
  ruleRef: 'retention:contact-email',
  ruleVersion: 1,
};

describe('privacy retention rules', () => {
  it('defaults new rule versions to prospective-only application', () => {
    const result = validatePrivacyRetentionRule(base);

    expect(result.valid).toBe(true);
    if (result.valid) {
      expect(result.rule.applicability).toBe('PROSPECTIVE_ONLY');
      expect(appliesPrivacyRetentionRuleToExistingContent(result.rule)).toBe(false);
      expect(Option.isNone(result.rule.retroactiveApprovalRef)).toBe(true);
    }
  });

  it('requires explicit approval before a rule can apply retroactively', () => {
    const rejected = validatePrivacyRetentionRule({ ...base, applicability: 'EXPLICIT_RETROACTIVE' });
    expect(rejected).toEqual({ reasons: ['retroactive_applicability_requires_explicit_approval'], valid: false });

    const approved = validatePrivacyRetentionRule({
      ...base,
      applicability: 'EXPLICIT_RETROACTIVE',
      retroactiveApprovalRef: 'approval:retention:1',
    });
    expect(approved.valid).toBe(true);
    if (approved.valid) {
      expect(appliesPrivacyRetentionRuleToExistingContent(approved.rule)).toBe(true);
    }
  });

  it('keeps the rule exact to content scope and rejects an inverted effective period', () => {
    const rejected = validatePrivacyRetentionRule({
      ...base,
      contentScopeRef: 'contact.email.verification-evidence',
      effectiveTo: Option.some(Schema.decodeUnknownSync(PrivacyIsoTimestampSchema)('2025-12-31T00:00:00Z')),
    });
    expect(rejected.valid).toBe(false);
    if (!rejected.valid) {
      expect(rejected.reasons).toContain('effective_period_is_invalid');
    }
  });
});
