import { Effect, Schema } from 'effect';

import type { TrustedPrincipalContext } from '../actions/principal-context.ts';
import { defineGlobalPolicy, denyPolicy } from '../actions/policy.ts';
import { AgentProposalCommandPayloadSchema } from './agent-proposal-command-contract.ts';
import type { AgentProposalCommandPayload } from './agent-proposal-command-contract.ts';

export const CONNECTION_SCOPE_REASON_CODE = 'connection_scope';
type ScopedPrincipal = Pick<TrustedPrincipalContext, 'authMethod' | 'connection'>;

/**
 * An approval connection writes by proposing. Reading its own proposal queue and the actor names shown on it is
 * the agent platform itself, not a business module the grant selects.
 */
const PROPOSAL_READ_KEYS: ReadonlySet<string> = new Set([
  'core.identity.agent-activity-actors',
  'core.identity.agent-proposal-queue',
]);
const PROPOSAL_ACTION_KEY = 'core.identity.mutate-agent-proposals';

/**
 * A connection with policy 'approval' writes only by proposing, also when it acts as its person rather than an
 * agent. The proposal queue then accepts that person as the proposer of their own proposals.
 */
export const isApprovalConnection = (principal: Partial<ScopedPrincipal>): boolean =>
  principal.authMethod === 'oauth_connection' && principal.connection?.writePolicy === 'approval';

/** Non-connection principals are unaffected; a connection may read only its granted modules and its proposals. */
export const isConnectionReadAllowed = (
  principal: ScopedPrincipal,
  read: { readonly owningModuleKey: string; readonly readKey: string },
): boolean => {
  if (principal.authMethod !== 'oauth_connection') {
    return true;
  }
  const { connection } = principal;
  if (connection === undefined) {
    return false;
  }
  return (
    connection.modules === 'all' ||
    connection.modules.some((module) => module.moduleId === read.owningModuleKey) ||
    (connection.writePolicy === 'approval' && PROPOSAL_READ_KEYS.has(read.readKey))
  );
};

/**
 * A connection may run write Actions only with policy 'direct' and module write. Verticals use the same rule for
 * the `canWrite` they report, so a read-only connection never sees write ability.
 */
export const isConnectionWriteAllowed = (principal: Partial<ScopedPrincipal>, moduleKey: string): boolean => {
  if (principal.authMethod !== 'oauth_connection') {
    return true;
  }
  const { connection } = principal;
  if (connection === undefined || connection.writePolicy !== 'direct') {
    return false;
  }
  return (
    connection.modules === 'all' ||
    connection.modules.some((module) => module.moduleId === moduleKey && module.access === 'write')
  );
};

/** An approval connection may only add proposals, and only for modules its grant lets it write. */
const isConnectionProposalInsert = (
  principal: Partial<ScopedPrincipal>,
  actionKey: string,
  command: AgentProposalCommandPayload,
): boolean => {
  const { connection } = principal;
  if (
    principal.authMethod !== 'oauth_connection' ||
    connection === undefined ||
    connection.writePolicy !== 'approval' ||
    actionKey !== PROPOSAL_ACTION_KEY ||
    command.operation !== 'insert'
  ) {
    return false;
  }
  const { modules } = connection;
  return command.proposals.every(
    ({ moduleKey }) =>
      modules === 'all' || modules.some((module) => module.moduleId === moduleKey && module.access === 'write'),
  );
};

/** Global Action Policy prepended by the Action runtime for every 'oauth_connection' principal. */
export const connectionScopePolicy = defineGlobalPolicy<unknown>({
  evaluate: ({ action, payload, principal }) =>
    isConnectionWriteAllowed(principal, action.owningModuleKey) ||
    (Schema.is(AgentProposalCommandPayloadSchema)(payload) &&
      isConnectionProposalInsert(principal, action.actionKey, payload))
      ? Effect.void
      : Effect.fail(denyPolicy(CONNECTION_SCOPE_REASON_CODE, 'The connected application may not run this Action')),
  policyKey: 'core.oauth-connection.scope',
});
