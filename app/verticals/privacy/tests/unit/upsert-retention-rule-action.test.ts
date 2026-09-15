import { Effect, Option, Schema } from 'effect';
import { describe, expect, it } from 'effect-rstest';

import { createActionCollector } from '../../../../packages/core-runtime/src/actions/collector.ts';
import { UpsertRetentionRulePayloadSchema } from '../../shared/actions/privacy-operations.ts';
import {
  AuthoritativePrivacyRetentionRuleVersionSchema,
  RetentionRuleAuthorityResolutionSchema,
} from '../../shared/domain/privacy-retention-rule.ts';
import type { AuthoritativePrivacyRetentionRuleVersion } from '../../shared/domain/privacy-retention-rule.ts';
import {
  handleUpsertRetentionRule,
  upsertRetentionRuleAction,
} from '../../src/actions/upsert-retention-rule.action.ts';
import type { UpsertRetentionRuleServices } from '../../src/actions/upsert-retention-rule.action.ts';
import { retentionRuleGovernanceAuthorityUnavailable } from '../../src/actions/retention-rule-governance-authority.ts';
import type { RetentionRuleGovernanceAuthorityService } from '../../src/actions/retention-rule-governance-authority.ts';
import { PrivacyActionRejected } from '../../src/actions/privacy-operation-action-support.ts';

const tenantId = '10000000-0000-4000-8000-000000000001';
const legalEntityId = '20000000-0000-4000-8000-000000000002';
const principalId = '30000000-0000-4000-8000-000000000003';
const actionInvocationId = '40000000-0000-4000-8000-000000000004';
const scope = {
  authMethod: 'session' as const,
  correlationId: 'retention-rule-action-test',
  legalEntityId,
  principalId,
  tenantId,
};

const requestInput = {
  applicability: 'PROSPECTIVE_ONLY' as const,
  businessStartRef: 'event:customer-closed',
  contentScopeRef: 'customer.email',
  effectiveFrom: '2026-01-01T00:00:00Z',
  effectiveTo: null,
  retentionWindow: { durationDays: 730, kind: 'DURATION' as const },
  retroactiveApprovalRef: null,
  ruleRef: 'rule:customer-email',
  ruleVersion: 1,
};
const request = Schema.decodeUnknownSync(UpsertRetentionRulePayloadSchema)({ request: requestInput });

const authoritativeRule = (overrides: Partial<AuthoritativePrivacyRetentionRuleVersion> = {}) =>
  Schema.decodeUnknownSync(AuthoritativePrivacyRetentionRuleVersionSchema)({
    applicability: request.request.applicability,
    authorityRef: 'retention-governance:1',
    businessStartAt: '2025-12-01T00:00:00Z',
    businessStartRef: request.request.businessStartRef,
    contentScopeRef: request.request.contentScopeRef,
    controllerRef: 'controller:techsio',
    dispositionOutcome: 'DELETE',
    effectiveFrom: request.request.effectiveFrom,
    effectiveTo: null,
    evidenceRefs: ['evidence:retention-rule:1'],
    policyRef: 'policy:retention:1',
    policyVersion: 1,
    provenanceRef: 'provenance:retention-rule:1',
    retentionWindow: { durationDays: 730, kind: 'DURATION' },
    retroactiveApprovalRef: null,
    ruleRef: request.request.ruleRef,
    ruleVersion: request.request.ruleVersion,
    ruleVersionId: 'rule-version:customer-email:1',
    ...overrides,
  });

const encodedAuthoritativeRule = (overrides: Partial<AuthoritativePrivacyRetentionRuleVersion> = {}) => {
  const rule = authoritativeRule(overrides);
  return {
    ...rule,
    effectiveTo: Option.getOrNull(rule.effectiveTo),
    retroactiveApprovalRef: Option.getOrNull(rule.retroactiveApprovalRef),
  };
};

const contextFor = (governanceAuthority: RetentionRuleGovernanceAuthorityService) => {
  const collector = createActionCollector(
    upsertRetentionRuleAction.descriptor.domainEvents,
    'privacy.core',
    upsertRetentionRuleAction.descriptor.accessEvidencePolicy,
    upsertRetentionRuleAction.descriptor.auditEvidenceSchema,
  );
  let persistedRule: AuthoritativePrivacyRetentionRuleVersion | undefined;
  const services: UpsertRetentionRuleServices = {
    governanceAuthority,
    upsertRetentionRule: (_tenant, _legalEntity, _invocation, resolution) =>
      Effect.sync(() => {
        persistedRule = resolution.rule;
        return resolution.rule;
      }),
  };
  return {
    collector,
    context: {
      actionInvocationId,
      addDomainEvent: collector.addDomainEvent,
      addOutboxMessage: collector.addOutboxMessage,
      recordAuditEvidence: collector.recordAuditEvidence,
      recordDataAccess: collector.recordDataAccess,
      scope,
      services,
    },
    persistedRule: () => persistedRule,
  };
};

const trustedGovernanceAuthority: RetentionRuleGovernanceAuthorityService = {
  resolveRetroactiveApproval: () => Effect.die('prospective rule must not ask for retroactive approval'),
  resolveRule: ({ asOf }) =>
    Effect.succeed(
      Schema.decodeUnknownSync(RetentionRuleAuthorityResolutionSchema)({
        asOf,
        legalEntityId,
        rule: encodedAuthoritativeRule(),
        status: 'CURRENT',
        tenantId,
      }),
    ),
};

describe('upsert retention rule authority boundary', () => {
  it('does not expose authority, Controller, policy, evidence, or business time in the public request', () => {
    const decoded = Schema.decodeUnknownSync(UpsertRetentionRulePayloadSchema)({
      request: {
        ...requestInput,
        authorityRef: 'forged-authority',
        businessStartAt: '2026-01-01T00:00:00Z',
        controllerRef: 'forged-controller',
        evidenceRefs: ['forged-evidence'],
        policyRef: 'forged-policy',
        policyVersion: 99,
        provenanceRef: 'forged-provenance',
        ruleVersionId: 'forged-version-id',
      },
    });

    expect(decoded.request).toEqual(request.request);
  });

  it.effect('records a prospective rule only from the trusted governance result', () =>
    Effect.gen(function* recordTrustedRule() {
      const { context, persistedRule } = contextFor(trustedGovernanceAuthority);
      const result = yield* handleUpsertRetentionRule(request, context);

      expect(result.controllerRef).toBe('controller:techsio');
      expect(persistedRule()).toEqual(result);
    }),
  );

  it.effect('fails closed when Retention Rule governance is unavailable', () =>
    Effect.gen(function* rejectUnavailableGovernance() {
      const { context } = contextFor(retentionRuleGovernanceAuthorityUnavailable);
      const error = yield* Effect.flip(handleUpsertRetentionRule(request, context));

      expect(Schema.is(PrivacyActionRejected)(error)).toBe(true);
      expect(error.reason).toContain('unavailable');
    }),
  );

  it.effect('rejects a forged authoritative Controller even when the request is prospective-only', () =>
    Effect.gen(function* rejectForgedRule() {
      const governanceAuthority: RetentionRuleGovernanceAuthorityService = {
        resolveRetroactiveApproval: () => Effect.die('must not be called'),
        resolveRule: ({ asOf }) =>
          Effect.succeed(
            Schema.decodeUnknownSync(RetentionRuleAuthorityResolutionSchema)({
              asOf,
              legalEntityId,
              rule: encodedAuthoritativeRule({ businessStartAt: '2026-02-01T00:00:00Z' }),
              status: 'CURRENT',
              tenantId,
            }),
          ),
      };
      const { context } = contextFor(governanceAuthority);
      const error = yield* Effect.flip(handleUpsertRetentionRule(request, context));

      expect(Schema.is(PrivacyActionRejected)(error)).toBe(true);
      expect(error.reason).toContain('invalid authoritative rule');
    }),
  );
});
