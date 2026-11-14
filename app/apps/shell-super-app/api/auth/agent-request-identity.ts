import type { OperationalScopeRequest } from '@app/core-runtime';
import { Context } from 'effect';

/** Core's persisted request transport, supplied once by the authenticated root ingress.
 * No default: a missing service fails closed, and reads never manufacture an Action idempotency key.
 * Keep the resolver-issued principal on the caller; these services carry transport metadata only.
 */
export class AgentReadRequestIdentity extends Context.Service<AgentReadRequestIdentity, OperationalScopeRequest>()(
  '@app/shell-super-app/api/auth/agent-request-identity/AgentReadRequestIdentity',
) {}
