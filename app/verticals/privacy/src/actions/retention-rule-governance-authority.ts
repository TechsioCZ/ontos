import { Context, Effect, Layer, Option } from 'effect';

import type {
  PrivacyRetentionRuleUpsertRequest,
  RetentionRuleAuthorityResolution,
  AuthoritativePrivacyRetentionRuleVersion,
} from '../../shared/domain/privacy-retention-rule.ts';
import { PrivacyActionRejected } from './privacy-action-rejected.ts';

interface RetentionRuleGovernanceContext {
  readonly actionInvocationId: string;
  readonly asOf: string;
  readonly legalEntityId: string;
  readonly principalId: string;
  readonly request: PrivacyRetentionRuleUpsertRequest;
  readonly tenantId: string;
}

export interface RetroactiveRetentionGovernanceContext {
  readonly actionInvocationId: string;
  readonly legalEntityId: string;
  readonly principalId: string;
  readonly rule: AuthoritativePrivacyRetentionRuleVersion;
  readonly tenantId: string;
}

export interface RetroactiveRetentionGovernanceApproval {
  readonly actionInvocationId: string;
  readonly approvalRef: string;
  readonly approved: boolean;
  readonly asOf: string;
  readonly contentScopeRef: string;
  readonly legalEntityId: string;
  readonly ruleRef: string;
  readonly ruleVersion: number;
  readonly ruleVersionId: string;
  /** Governance freshness is authoritative; approved alone is never sufficient. */
  readonly status: 'CURRENT' | 'STALE' | 'REVOKED' | 'CONFLICT' | 'UNAVAILABLE';
  readonly tenantId: string;
}

export interface RetentionRuleGovernanceAuthorityService {
  readonly resolveRetroactiveApproval: (
    context: RetroactiveRetentionGovernanceContext,
  ) => Effect.Effect<RetroactiveRetentionGovernanceApproval, PrivacyActionRejected>;
  /** Resolves the complete current rule; the public Action carries intent only. */
  readonly resolveRule: (
    context: RetentionRuleGovernanceContext,
  ) => Effect.Effect<RetentionRuleAuthorityResolution, PrivacyActionRejected>;
}

export class RetentionRuleGovernanceAuthority extends Context.Service<
  RetentionRuleGovernanceAuthority,
  RetentionRuleGovernanceAuthorityService
>()('@app/privacy/actions/retention-rule-governance-authority/RetentionRuleGovernanceAuthority') {}

export const retentionRuleGovernanceAuthorityUnavailable = Object.freeze({
  resolveRetroactiveApproval: () =>
    Effect.fail(
      new PrivacyActionRejected({
        code: 'privacy_action_rejected',
        reason: 'Authoritative retroactive Retention Rule governance is unavailable',
      }),
    ),
  resolveRule: () =>
    Effect.fail(
      new PrivacyActionRejected({
        code: 'privacy_action_rejected',
        reason: 'Authoritative Retention Rule governance is unavailable',
      }),
    ),
}) satisfies RetentionRuleGovernanceAuthorityService;

export const RetentionRuleGovernanceAuthorityUnavailableLive = Layer.succeed(
  RetentionRuleGovernanceAuthority,
  retentionRuleGovernanceAuthorityUnavailable,
);

const validateApprovalStatus = (approval: RetroactiveRetentionGovernanceApproval): string | undefined => {
  if (approval.status !== 'CURRENT') {
    return `Retroactive governance approval is ${approval.status.toLowerCase()}`;
  }
  if (!approval.approved) {
    return 'Retroactive Retention Rule governance approval was not granted';
  }
  return undefined;
};

const validateApprovalCorrelation = (
  context: RetroactiveRetentionGovernanceContext,
  approval: RetroactiveRetentionGovernanceApproval,
): string | undefined => {
  if (approval.actionInvocationId !== context.actionInvocationId) {
    return 'Retroactive governance approval correlation does not match';
  }
  if (Option.isNone(context.rule.retroactiveApprovalRef)) {
    return 'Retroactive governance approval reference does not match';
  }
  if (approval.approvalRef !== context.rule.retroactiveApprovalRef.value) {
    return 'Retroactive governance approval reference does not match';
  }
  return undefined;
};

const validateApprovalIdentity = (
  context: RetroactiveRetentionGovernanceContext,
  approval: RetroactiveRetentionGovernanceApproval,
): string | undefined => {
  const { rule } = context;
  if (approval.tenantId !== context.tenantId) {
    return 'Retroactive governance approval tenant does not match';
  }
  if (approval.legalEntityId !== context.legalEntityId) {
    return 'Retroactive governance approval Legal Entity does not match';
  }
  if (approval.ruleRef !== rule.ruleRef) {
    return 'Retroactive governance approval Rule does not match';
  }
  if (approval.ruleVersion !== rule.ruleVersion) {
    return 'Retroactive governance approval Rule version does not match';
  }
  if (approval.ruleVersionId !== rule.ruleVersionId) {
    return 'Retroactive governance approval Rule version identity does not match';
  }
  if (approval.contentScopeRef !== rule.contentScopeRef) {
    return 'Retroactive governance approval content scope does not match';
  }
  if (approval.asOf !== rule.effectiveFrom) {
    return 'Retroactive governance approval as-of does not match';
  }
  return undefined;
};

export const validateRetroactiveRetentionGovernanceApproval = (
  context: RetroactiveRetentionGovernanceContext,
  approval: RetroactiveRetentionGovernanceApproval,
): string | undefined =>
  validateApprovalStatus(approval) ??
  validateApprovalCorrelation(context, approval) ??
  validateApprovalIdentity(context, approval);
