import type { AgentModuleGrant, AgentWritePolicy } from '@app/shared-contracts/agent-access';
import type { ConnectDraftSummary } from '@app/shared-contracts/oauth-connections';

/** Why a connect call failed; the screens map it to Czech copy. */
export type ConnectFailure = 'signedOut' | 'expired' | 'forbidden' | 'connected' | 'error';

export type PolicyReasonKey = 'shell.connect.policy.agentApprovalOnly' | 'shell.connect.policy.agentReadOnly';

export const POLICY_RANK: Record<AgentWritePolicy, number> = { read_only: 0, approval: 1, direct: 2 };

/** A policy above the ceiling (agent profile or grant) is shown but cannot be chosen. */
export const policyOptionState = (
  policy: AgentWritePolicy,
  cap: AgentWritePolicy,
): { disabled: boolean; reasonKey: PolicyReasonKey | null } => {
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
  return [...picks]
    .filter(([, pick]) => pick.read)
    .map(([moduleId, pick]): AgentModuleGrant => ({ access: pick.write ? 'write' : 'read', moduleId }));
};

export const summaryModuleLabels = (
  modules: ConnectDraftSummary['modules'],
): 'all' | { read: string[]; write: string[] } => {
  if (modules === 'all') {
    return 'all';
  }
  return {
    read: modules.filter((module) => module.read).map((module) => module.label),
    write: modules.filter((module) => module.write).map((module) => module.label),
  };
};

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null;

/** Only absolute http(s) URLs and same-origin paths may be navigated to. */
const isNavigable = (value: unknown): value is string =>
  typeof value === 'string' &&
  (value.startsWith('http://') || value.startsWith('https://') || (value.startsWith('/') && !value.startsWith('//')));

/** Where Better Auth wants the browser next: `url`, `redirect_uri`, or the followed redirect of the response. */
export const navigationTarget = (body: unknown, redirected: boolean, url: string): string | undefined => {
  const fields = isRecord(body) ? body : {};
  const candidates: unknown[] = [fields['url'], fields['redirect_uri'], redirected ? url : undefined];
  return candidates.find(isNavigable);
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
  if (reason === 'connected') {
    return 'shell.connect.error.connected';
  }
  return 'shell.connect.error.failed';
};
