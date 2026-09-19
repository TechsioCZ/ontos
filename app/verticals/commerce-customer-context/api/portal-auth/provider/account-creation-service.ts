import { Context } from 'effect';
import type { Effect } from 'effect';

import type {
  CommercePortalAccountCreateInputBoundary,
  CommercePortalAccountCreateResult,
  CommercePortalAuthAccountCreationFailure,
} from './account-create.ts';

/**
 * The private provider account-creation capability the enrollment start route dispatches through.
 * The tag is declared apart from its Better Auth implementation so a deployment that installed no
 * realm can name the same capability without loading the provider it deliberately does not have.
 */
export class CommercePortalAuthAccountCreationService extends Context.Service<
  CommercePortalAuthAccountCreationService,
  {
    readonly createAccount: (
      input: CommercePortalAccountCreateInputBoundary,
    ) => Effect.Effect<CommercePortalAccountCreateResult, CommercePortalAuthAccountCreationFailure>;
  }
>()(
  '@app/commerce-customer-context/api/portal-auth/provider/account-creation-service/CommercePortalAuthAccountCreationService',
) {}
