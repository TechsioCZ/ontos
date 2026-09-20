import { Context } from 'effect';
import type { Effect, Option } from 'effect';

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
  /**
   * Confirms that the provider still holds the exact stable subject Commerce already observed.
   * Owner reconciliation calls it after an unknown provider outcome without an `email`, so account
   * continuity can never be inferred from a login identifier; account creation adds the address it
   * just submitted, which narrows the probe to the row that submission was meant to produce.
   */
  readonly existsByProviderSubject: (input: {
    readonly email?: string;
    readonly providerSubjectId: string;
  }) => Effect.Effect<boolean, CommercePortalAuthAccountCreationUnavailable>;
  /**
   * The subject the provider recorded for one governed owner invocation, written inside the very
   * call that committed the account. It is the only key a creation whose answer was lost leaves
   * behind, so owner reconciliation resolves a missing recorded subject through it; `None` means
   * the provider never committed that creation and a fresh one is still allowed.
   */
  readonly subjectForOwnerInvocation: (input: {
    readonly ownerInvocationId: string;
  }) => Effect.Effect<Option.Option<string>, CommercePortalAuthAccountCreationUnavailable>;
}

export class CommercePortalAuthAccountLookupService extends Context.Service<
  CommercePortalAuthAccountLookupService,
  CommercePortalAuthAccountLookup
>()(
  '@app/commerce-customer-context/api/portal-auth/provider/account-lookup-service/CommercePortalAuthAccountLookupService',
) {}
