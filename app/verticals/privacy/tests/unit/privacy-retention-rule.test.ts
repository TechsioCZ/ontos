import { Option, Schema } from 'effect';
import { describe, expect, it } from 'effect-rstest';

import {
  AuthoritativePrivacyRetentionRuleVersionSchema,
  appliesPrivacyRetentionRuleToExistingContent,
  validatePrivacyRetentionRule,
} from '../../shared/domain/privacy-retention-rule.ts';
import { PrivacyIsoTimestampSchema } from '../../shared/domain/privacy-subject.ts';
import { validateRetroactiveRetentionGovernanceApproval } from '../../src/actions/retention-rule-governance-authority.ts';

type RetroactiveGovernanceApproval = Parameters<typeof validateRetroactiveRetentionGovernanceApproval>[1];

const effectiveFrom = Schema.decodeUnknownSync(PrivacyIsoTimestampSchema)('2026-01-01T00:00:00Z');
const ruleVersionId = Schema.decodeUnknownSync(Schema.String.pipe(Schema.brand('RuleVersionId')))('rule-version:1');
const base = {
  authorityRef: 'authority:legal',
  businessStartAt: '2025-12-01T00:00:00Z',
  businessStartRef: 'event:account-closed',
  contentScopeRef: 'contact.email',
  controllerRef: 'controller:techsio',
  dispositionOutcome: 'DELETE' as const,
  effectiveFrom,
  evidenceRefs: ['evidence:retention-rule:1'],
  policyRef: 'policy:retention',
  policyVersion: 1,
  provenanceRef: 'provenance:retention-rule:1',
  retentionWindow: { durationDays: 730, kind: 'DURATION' as const },
  ruleRef: 'retention:contact-email',
  ruleVersion: 1,
  ruleVersionId,
};

const makeRetroactiveGovernanceFixture = (overrides: Partial<RetroactiveGovernanceApproval> = {}) => {
  const result = validatePrivacyRetentionRule({
    ...base,
    applicability: 'EXPLICIT_RETROACTIVE',
    retroactiveApprovalRef: 'approval:retention:1',
  });
  if (!result.valid) {
    throw new Error(`Expected a valid retroactive retention rule fixture: ${result.reasons.join(', ')}`);
  }
  const rule = Schema.decodeUnknownSync(AuthoritativePrivacyRetentionRuleVersionSchema)({
    ...result.rule,
    effectiveTo: Option.getOrNull(result.rule.effectiveTo),
    retroactiveApprovalRef: Option.getOrNull(result.rule.retroactiveApprovalRef),
  });
  const context = {
    actionInvocationId: 'action:1',
    legalEntityId: 'legal-entity:1',
    principalId: 'principal:1',
    rule,
    tenantId: 'tenant:1',
  };
  const approval: RetroactiveGovernanceApproval = {
    actionInvocationId: context.actionInvocationId,
    approvalRef: 'approval:retention:1',
    approved: true,
    asOf: rule.effectiveFrom,
    contentScopeRef: rule.contentScopeRef,
    legalEntityId: context.legalEntityId,
    ruleRef: rule.ruleRef,
    ruleVersion: rule.ruleVersion,
    ruleVersionId: rule.ruleVersionId,
    status: 'CURRENT',
    tenantId: context.tenantId,
    ...overrides,
  };
  return { approval, context };
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

  it('rejects a retention end before the trusted business start', () => {
    const rejected = validatePrivacyRetentionRule({
      ...base,
      retentionWindow: { endAt: '2025-11-30T23:59:59Z', kind: 'END_AT' },
    });
    expect(rejected.valid).toBe(false);
    if (!rejected.valid) {
      expect(rejected.reasons).toContain('retention_period_is_invalid');
    }
  });

  it('requires retroactive governance approval to correlate to the invoking Action', () => {
    const { approval, context } = makeRetroactiveGovernanceFixture({ actionInvocationId: 'action:other' });
    expect(validateRetroactiveRetentionGovernanceApproval(context, approval)).toBe(
      'Retroactive governance approval correlation does not match',
    );
  });

  it.each(['STALE', 'REVOKED', 'CONFLICT'] as const)('rejects %s governance approval', (status) => {
    const { approval, context } = makeRetroactiveGovernanceFixture({ status });
    expect(validateRetroactiveRetentionGovernanceApproval(context, approval)).toBe(
      `Retroactive governance approval is ${status.toLowerCase()}`,
    );
  });
});
