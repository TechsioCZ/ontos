import { Context, Schema } from 'effect';
import type { Effect } from 'effect';

import type { CommercePortalAuthAccountCreationUnavailable } from './account-creation-unavailable.ts';

const correlationUuid = Schema.String.check(Schema.isUUID());

/**
 * The governed identity one account creation is correlated by. The brands are the same ones the
 * private account-creation input carries, so a Tenant can never be read where an invocation is
 * meant, and the realm decodes the identity it was handed before it writes a row against it.
 */
export const CommercePortalAuthAccountCreationCorrelationSchema = Schema.Struct({
  ownerInvocationId: correlationUuid.pipe(Schema.brand('ActionInvocationId')),
  portalEnrollmentAttemptId: correlationUuid.pipe(Schema.brand('EnrollmentAttemptId')),
  tenantId: correlationUuid.pipe(Schema.brand('TenantId')),
}).annotate({ parseOptions: { onExcessProperty: 'error' } });

/**
 * The provider-side write half of the account-creation correlation. The realm calls it from its own
 * Better Auth user-creation hook, so the row lands in the same provider database, in the same
 * provider call that commits the account — never from the owner side, which is exactly the side
 * whose answer can be lost.
 *
 * The owner-local interface lives with its Context tag for the same reason the account lookup's
 * does: the drizzle adapter that implements it stays in `src/portal-auth/persistence/`, and the
 * `api/` boundary never depends on a database capability.
 */
export interface CommercePortalAuthAccountCreationCorrelation {
  /**
   * Records one owner invocation against the subject the provider just committed. A replay of the
   * same invocation with the same subject is idempotent; the same invocation with a different
   * subject, or the same subject under a different invocation, is a conflict the provider refuses.
   */
  readonly record: (input: {
    readonly ownerInvocationId: string;
    readonly portalEnrollmentAttemptId: string;
    readonly providerSubjectId: string;
    readonly tenantId: string;
  }) => Effect.Effect<void, CommercePortalAuthAccountCreationUnavailable>;
}

export class CommercePortalAuthAccountCreationCorrelationService extends Context.Service<
  CommercePortalAuthAccountCreationCorrelationService,
  CommercePortalAuthAccountCreationCorrelation
>()(
  '@app/commerce-customer-context/api/portal-auth/provider/account-correlation-service/CommercePortalAuthAccountCreationCorrelationService',
) {}
