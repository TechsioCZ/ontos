import type { OAuthAgentConnection, OperationalScope } from '@app/core-runtime';
import { OAUTH_GRANT_CONTEXT_PREFIX } from '@app/shared-contracts/oauth-connections';

import type { GrantRow } from './types.ts';

/**
 * The trusted `oauth_connection` scope of one persisted grant (O66): the connection's own principal, with
 * the consent ceiling the row records. It is the scope an MCP request's acting principal is evaluated in
 * when no session asks for it, and it names no binding and mints no id the row does not already carry.
 */
export const connectionScopeOf = (grant: GrantRow, agentConnection?: OAuthAgentConnection): OperationalScope => {
  const base = {
    clientId: grant.clientId,
    clientName: grant.clientName.slice(0, 200),
    grantId: grant.grantId,
    modules:
      grant.modules === 'all'
        ? ('all' as const)
        : grant.modules.map((module) => ({ access: module.access, moduleId: String(module.moduleId) })),
    writePolicy: grant.writePolicy,
  };
  const connection =
    agentConnection === undefined || grant.actingKind !== 'agent' ? base : { ...base, agentConnection };
  const scope: OperationalScope = {
    authContextRef: `${OAUTH_GRANT_CONTEXT_PREFIX}${grant.grantId}`,
    authMethod: 'oauth_connection',
    connection,
    correlationId: `oauth-connection:${grant.grantId}`,
    legalEntityId: grant.legalEntityId,
    principalId: grant.actingPrincipalId,
    tenantId: grant.tenantId,
  };
  if (grant.actingKind === 'agent') {
    return Object.freeze({ ...scope, delegatedByPrincipalId: grant.userPrincipalId });
  }
  return Object.freeze(scope);
};
