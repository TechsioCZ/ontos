import { Context } from 'effect';
import type { Effect } from 'effect';

import type { AgentProfileSetupError } from './agent-operator-session.mts';

type AgentSetupError = InstanceType<typeof AgentProfileSetupError>;

/** One reviewed agent the operator seeds with its fixed id, before its profile is written through the Action. */
export interface SeededAgentIdentity {
  readonly displayName: string;
  readonly legalEntityId: string;
  readonly principalId: string;
  readonly tenantId: string;
}

/**
 * The operator's platform-side path for an agent with a fixed, reviewed id: it creates the agent principal and its
 * company membership on the operator's own database connection. No tenant user reaches it; the product's
 * `create-agent` Action names no principal (Core gives it its id). The profile itself is then written through that
 * Action's `configure-agent` operation, so the audit is the product's.
 */
export class AgentSeedIdentityWriter extends Context.Service<
  AgentSeedIdentityWriter,
  { readonly seed: (identity: SeededAgentIdentity) => Effect.Effect<void, AgentSetupError> }
>()('AgentSeedIdentityWriter') {}
