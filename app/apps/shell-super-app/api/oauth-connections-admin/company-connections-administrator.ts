import { ContextAccess } from '@app/core-runtime';
import type { TrustedPrincipalContext } from '@app/core-runtime';
import { Effect } from 'effect';

/**
 * STOPPED (legacy question, pending a decision): whether this person administers the selected company's
 * connected applications (sees every connection of the company, disconnects another person's connection,
 * sets an agent's operators here). No v2 capability answers this question today; it still asks the
 * legacy `read_people` relations, which authorization v2 never writes, so on a v2-only tenant it answers
 * false (refused, never widened). Proposed v2 owner: an `admin` capability
 * `core.identity.oauth-connection.administer` in the core.identity catalogue, decided in the company scope.
 */
export const legacyCompanyConnectionsAdministrator = Effect.fn('ConnectionsAdmin.legacyCompanyAdministrator')(
  function* legacyCompanyConnectionsAdministrator(
    principal: TrustedPrincipalContext & { readonly legalEntityId: string },
  ) {
    const access = yield* ContextAccess;
    const { legalEntityId, principalId, tenantId } = principal;
    const [tenant, company] = yield* Effect.all(
      [
        access.tenants({ permission: 'read_people', principalId, tenantIds: [tenantId] }),
        access.legalEntities({ legalEntityIds: [legalEntityId], permission: 'read_people', principalId, tenantId }),
      ],
      { concurrency: 2 },
    );
    return [...tenant, ...company].some((decision) => decision.decision === 'allowed');
  },
);
