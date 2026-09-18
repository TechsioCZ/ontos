import { Context } from 'effect';
import type { Effect } from 'effect';

import type { CommercePortalAuthAccountCreationUnavailable } from './account-creation-unavailable.ts';

/**
 * Better Auth intentionally returns a synthetic success for duplicate emails when verification is
 * required. The private port therefore confirms the returned subject was durably inserted before
 * reporting CREATED; this lookup exposes no password, token, or user record.
 *
 * The owner-local interface lives with its Context tag so this port declares its own contract: the
 * drizzle adapter that implements it stays in `src/portal-auth/persistence/`, and the `api/`
 * boundary never depends on a database capability.
 */
export interface CommercePortalAuthAccountLookup {
  /**
   * Checks the provider's canonical email identifier without returning a user or subject id.
   * This preflight is required because Better Auth can return a synthetic success for duplicates.
   */
  readonly existsByEmail: (input: {
    readonly email: string;
  }) => Effect.Effect<boolean, CommercePortalAuthAccountCreationUnavailable>;
  readonly existsByProviderSubjectAndEmail: (input: {
    readonly email: string;
    readonly providerSubjectId: string;
  }) => Effect.Effect<boolean, CommercePortalAuthAccountCreationUnavailable>;
}

export class CommercePortalAuthAccountLookupService extends Context.Service<
  CommercePortalAuthAccountLookupService,
  CommercePortalAuthAccountLookup
>()(
  '@app/commerce-customer-context/api/portal-auth/provider/account-lookup-service/CommercePortalAuthAccountLookupService',
) {}
