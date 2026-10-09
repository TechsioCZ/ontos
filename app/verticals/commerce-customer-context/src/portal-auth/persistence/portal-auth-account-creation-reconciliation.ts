import { and, eq } from 'drizzle-orm';
import { Effect, Layer, Option } from 'effect';

import { CommercePortalAuthAccountCreationUnavailable } from '../../../api/portal-auth/provider/account-creation-unavailable.ts';
import { CommercePortalAuthAccountCreationProviderService } from '../../../api/portal-auth/provider/account-creation-provider-service.ts';
import { CommercePortalAuthAccountCreationReconciliationService } from '../../../api/portal-auth/provider/account-creation-reconciliation-service.ts';
import type { CommercePortalAuthAccountCreationReconciliation } from '../../../api/portal-auth/provider/account-creation-reconciliation-service.ts';
import { CommercePortalAuthDatabase } from './portal-auth-database.ts';
import type { CommercePortalAuthDatabaseExecutor } from './portal-auth-database-types.ts';
import { user } from './portal-auth-tables.ts';

const reconciliationUnavailable = (reason: string, cause: unknown): CommercePortalAuthAccountCreationUnavailable =>
  Object.defineProperty(new CommercePortalAuthAccountCreationUnavailable({ reason }), 'cause', {
    configurable: false,
    enumerable: false,
    value: cause,
  });

const makeCommercePortalAuthAccountCreationReconciliation = (
  database: CommercePortalAuthDatabaseExecutor,
  provider: CommercePortalAuthAccountCreationProviderService['Service'],
): CommercePortalAuthAccountCreationReconciliation => ({
  reissueVerificationEmail: Effect.fn('CommercePortalAuthAccountCreationReconciliation.reissueVerificationEmail')(
    function* reissueVerificationEmail({ ownerInvocationId }) {
      const correlated = yield* database
        .select({ email: user.email, providerSubjectId: user.id })
        .from(user)
        .where(eq(user.enrollmentOwnerInvocationId, ownerInvocationId))
        .limit(1)
        .pipe(
          Effect.mapError((cause) =>
            reconciliationUnavailable(
              'The Commerce portal account creation correlation could not be read for reconciliation',
              cause,
            ),
          ),
        );
      const [account] = correlated;
      if (account === undefined) {
        return Option.none();
      }

      yield* provider.api
        .sendVerificationEmail({ body: { email: account.email } })
        .pipe(
          Effect.mapError((cause) =>
            reconciliationUnavailable(
              'Commerce portal account reconciliation could not reissue the verification email',
              cause,
            ),
          ),
        );

      const persisted = yield* database
        .select({ providerSubjectId: user.id })
        .from(user)
        .where(and(eq(user.id, account.providerSubjectId), eq(user.enrollmentOwnerInvocationId, ownerInvocationId)))
        .limit(1)
        .pipe(
          Effect.mapError((cause) =>
            reconciliationUnavailable(
              'The Commerce portal account correlation could not be confirmed after verification delivery',
              cause,
            ),
          ),
        );
      return persisted[0] === undefined
        ? Option.none()
        : Option.some({ providerSubjectId: persisted[0].providerSubjectId });
    },
  ),
});

export const CommercePortalAuthAccountCreationReconciliationLive = Layer.effect(
  CommercePortalAuthAccountCreationReconciliationService,
  Effect.gen(function* makeCommercePortalAuthAccountCreationReconciliationLive() {
    const database = yield* CommercePortalAuthDatabase;
    const provider = yield* CommercePortalAuthAccountCreationProviderService;
    return makeCommercePortalAuthAccountCreationReconciliation(database.executor, provider);
  }),
);
