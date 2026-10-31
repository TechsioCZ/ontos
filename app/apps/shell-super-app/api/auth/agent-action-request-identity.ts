import type { OperationalScopeRequest } from '@app/core-runtime';
import { Context } from 'effect';

/** Core's persisted Action transport, supplied by authenticated ingress after requiring the client's idempotency key.
 * No default or ID generation: missing Action identity cannot be satisfied by read-only request metadata.
 * Keep the resolver-issued principal on the caller; this service carries transport metadata only.
 */
export class AgentActionRequestIdentity extends Context.Service<
  AgentActionRequestIdentity,
  OperationalScopeRequest & { readonly idempotencyKey: string }
>()('@app/shell-super-app/api/auth/agent-action-request-identity/AgentActionRequestIdentity') {}
