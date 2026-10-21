/** Who calls the platform approval endpoints, the errors they can get, and which modules they may open/change. */
import { openDemoAccountGrants } from '@app/core-runtime';
import type { TrustedPrincipalContext } from '@app/core-runtime';
import { Data, Effect } from 'effect';

import { loadAgentProfiles } from '../auth/agent-store.ts';
import { moduleAccessSets } from './approval-logic.ts';
import { AgentStoreUnavailable } from './proposal-store.ts';

export interface AgentPlatformCaller {
  readonly legalName: string;
  readonly principal: TrustedPrincipalContext & { readonly legalEntityId: string };
}

/** Czech `reason` is returned to the client as the problem detail (HTTP 403). */
export class AgentPlatformForbidden extends Data.TaggedError('AgentPlatformForbidden')<{ readonly reason: string }> {}

/** Czech `reason` is returned to the client as the problem detail (HTTP 422). */
export class AgentPlatformInvalid extends Data.TaggedError('AgentPlatformInvalid')<{ readonly reason: string }> {}

/** Modules the caller can open (`access`) and change (`write`) in its current company, from its SpiceDB grants. */
export const callerModuleAccess = Effect.fn('AgentPlatform.callerModuleAccess')(function* callerModuleAccess(
  caller: AgentPlatformCaller,
) {
  const relationships = yield* Effect.scoped(
    Effect.flatMap(openDemoAccountGrants, (grants) => grants.relationshipsOf(caller.principal.principalId)),
  ).pipe(Effect.mapError((cause) => new AgentStoreUnavailable({ cause })));
  return moduleAccessSets(relationships, caller.principal.legalEntityId);
});

/**
 * API-key agents may queue proposals only with an `approval` or `direct` write policy (a read-only agent, level A,
 * may not). MCP connectors check the policy of their connection in connector-service.ts.
 */
export const assertKeyAgentMayPropose = Effect.fn('AgentPlatform.assertKeyAgentMayPropose')(
  function* assertKeyAgentMayPropose(caller: AgentPlatformCaller) {
    const { principalId, tenantId } = caller.principal;
    const profiles = yield* loadAgentProfiles(tenantId, [principalId]).pipe(
      Effect.mapError((cause) => new AgentStoreUnavailable({ cause })),
    );
    if ((profiles.get(principalId)?.writePolicy ?? 'read_only') === 'read_only') {
      return yield* new AgentPlatformForbidden({ reason: 'Agent smí jen číst, návrhy změn podávat nemůže.' });
    }
  },
);
