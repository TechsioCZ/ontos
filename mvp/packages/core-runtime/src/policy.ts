// @effect-diagnostics strictBooleanExpressions:off
import type { RuntimeContext, SerializableGateResult } from './types.ts';

export interface PolicyInput {
  context: RuntimeContext;
  moduleKey: string;
  policyKey?: string;
  forceDeny?: boolean;
}

export interface ResourceReadPolicyInput {
  context: RuntimeContext;
  resourceId: string;
  policyKey?: string;
  forceDeny?: boolean;
}

export type PolicyDecision =
  | {
      ok: true;
      policy: 'allowed';
    }
  | {
      ok: false;
      policy: 'denied';
      code: 'policy_denied';
      message: string;
    };

export const evaluateWritePolicy = (input: PolicyInput): PolicyDecision => {
  if (input.forceDeny === true || input.policyKey === 'demo.deny') {
    return {
      code: 'policy_denied',
      message: `Policy '${input.policyKey ?? 'inline-deny'}' denied '${input.moduleKey}'.`,
      ok: false,
      policy: 'denied',
    };
  }

  return {
    ok: true,
    policy: 'allowed',
  };
};

export const evaluateReadPolicy = (input: ResourceReadPolicyInput): PolicyDecision => {
  if (input.forceDeny === true || input.policyKey === 'demo.read.deny') {
    return {
      code: 'policy_denied',
      message: `Policy '${input.policyKey ?? 'resource-read-policy'}' denied '${input.resourceId}'.`,
      ok: false,
      policy: 'denied',
    };
  }

  return {
    ok: true,
    policy: 'allowed',
  };
};

export const policyDeniedResult = (
  input: PolicyInput,
  message: string,
): SerializableGateResult => ({
  authorization: 'allowed',
  code: 'policy_denied',
  message,
  moduleKey: input.moduleKey,
  ok: false,
  policy: 'denied',
  principalId: input.context.principal.principalId,
  tenantSlug: input.context.tenant.slug,
});
