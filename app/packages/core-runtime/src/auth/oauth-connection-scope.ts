import { Effect } from 'effect';

import type { TrustedPrincipalContext } from '../actions/principal-context.ts';
import { defineGlobalPolicy, denyPolicy } from '../actions/policy.ts';

export const CONNECTION_SCOPE_REASON_CODE = 'connection_scope';
type ScopedPrincipal = Pick<TrustedPrincipalContext, 'authMethod' | 'connection'>;

/** Non-connection principals are unaffected; a connection may read only its granted modules. */
export const isConnectionReadAllowed = (principal: ScopedPrincipal, moduleKey: string): boolean => {
  if (principal.authMethod !== 'oauth_connection') {
    return true;
  }
  const { connection } = principal;
  if (connection === undefined) {
    return false;
  }
  return connection.modules === 'all' || connection.modules.some((module) => module.moduleId === moduleKey);
};

/** A connection may run write Actions only with policy 'direct' and module write. */
export const isConnectionWriteAllowed = (principal: ScopedPrincipal, moduleKey: string): boolean => {
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

/** Global Action Policy prepended by the Action runtime for every 'oauth_connection' principal. */
export const connectionScopePolicy = defineGlobalPolicy<unknown>({
  evaluate: ({ action, principal }) =>
    isConnectionWriteAllowed(principal, action.owningModuleKey)
      ? Effect.void
      : Effect.fail(denyPolicy(CONNECTION_SCOPE_REASON_CODE, 'The connected application may not run this Action')),
  policyKey: 'core.oauth-connection.scope',
});
