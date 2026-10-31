import { AgentModuleKeySchema } from '@app/shared-contracts/agent-proposals';
import { Schema } from 'effect';
import type { AgentModuleGrant, AgentWritePolicy } from '@app/shared-contracts/agent-access';
import type { ConnectOutcome } from './connect-client.ts';
import type { ConnectDraftSummary } from '@app/shared-contracts/oauth-connections';

/** Why a connect call failed; the screens map it to Czech copy. */
export const ConnectFailureSchema = Schema.Literals([
  'signedOut',
  'expired',
  'forbidden',
  'agentGone',
  'connected',
  'error',
]);
export type ConnectFailure = typeof ConnectFailureSchema.Type;

export const PolicyReasonKeySchema = Schema.Literals([
  'shell.connect.policy.agentApprovalOnly',
  'shell.connect.policy.agentReadOnly',
]);
export type PolicyReasonKey = typeof PolicyReasonKeySchema.Type;

export const POLICY_RANK = { approval: 1, direct: 2, read_only: 0 } satisfies Record<AgentWritePolicy, number>;

interface PolicyOptionState {
  readonly disabled: boolean;
  readonly reasonKey: PolicyReasonKey | null;
}

/** A policy above the ceiling (agent profile or grant) is shown but cannot be chosen. */
export const policyOptionState = (policy: AgentWritePolicy, cap: AgentWritePolicy): PolicyOptionState => {
  if (POLICY_RANK[policy] <= POLICY_RANK[cap]) {
    return { disabled: false, reasonKey: null };
  }
  return {
    disabled: true,
    reasonKey: cap === 'approval' ? 'shell.connect.policy.agentApprovalOnly' : 'shell.connect.policy.agentReadOnly',
  };
};

/** Safest writing mode the ceiling allows, so the person must opt in to direct changes. */
export const defaultPolicy = (cap: AgentWritePolicy): AgentWritePolicy =>
  POLICY_RANK[cap] >= 1 ? 'approval' : 'read_only';

export const buildModulesRequest = (
  mode: 'all' | 'pick',
  picks: ReadonlyMap<string, { read: boolean; write: boolean }>,
): 'all' | AgentModuleGrant[] => {
  if (mode === 'all') {
    return 'all';
  }
  return [...picks].flatMap(([moduleId, pick]): AgentModuleGrant[] =>
    pick.read ? [{ access: pick.write ? 'write' : 'read', moduleId: AgentModuleKeySchema.make(moduleId) }] : [],
  );
};

interface SummaryModuleLabels {
  readonly read: string[];
  readonly write: string[];
}

export const summaryModuleLabels = (modules: ConnectDraftSummary['modules']): 'all' | SummaryModuleLabels => {
  if (modules === 'all') {
    return 'all';
  }
  const read: string[] = [];
  const write: string[] = [];
  for (const module of modules) {
    if (module.read) {
      read.push(module.label);
    }
    if (module.write) {
      write.push(module.label);
    }
  }
  return { read, write };
};

const isRecord = Schema.is(Schema.JsonObject);
const NavigableUrl = Schema.String.check(Schema.isPattern(/^(?:https?:\/\/|\/(?!\/))/u));

/** Where Better Auth wants the browser next: `url`, `redirect_uri`, or the followed redirect of the response. */
export const navigationTarget = (
  body: Schema.Json | undefined,
  redirected: boolean,
  url: string,
): string | undefined => {
  const fields = isRecord(body) ? body : {};
  const candidates = [fields['url'], fields['redirect_uri'], redirected ? url : undefined];
  return candidates.find(Schema.is(NavigableUrl));
};

export const readOAuthQuery = (search: string): string => (search.startsWith('?') ? search.slice(1) : search);

export const failureKey = (reason: ConnectFailure) => {
  if (reason === 'signedOut') {
    return 'shell.connect.error.signedOut';
  }
  if (reason === 'expired') {
    return 'shell.connect.error.expired';
  }
  if (reason === 'forbidden') {
    return 'shell.connect.error.forbidden';
  }
  if (reason === 'agentGone') {
    return 'shell.connect.error.agentGone';
  }
  if (reason === 'connected') {
    return 'shell.connect.error.connected';
  }
  return 'shell.connect.error.failed';
};

export const loadFailure = <Value>(
  query: string | undefined,
  outcome: ConnectOutcome<Value> | undefined,
): ConnectFailure | undefined => {
  if (query === '') {
    return 'expired';
  }
  return outcome?.status === 'failed' ? outcome.reason : undefined;
};
