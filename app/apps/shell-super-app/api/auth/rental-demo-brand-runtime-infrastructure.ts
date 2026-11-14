import {
  IdentityLifecycleConflictError,
  IdentityPersistenceUnavailableError,
  IdentityTargetInvalidError,
  PrincipalResolver,
} from '@app/core-runtime';
import { demoCompanyTenantId, rentalDemoBrandProfiles } from '@app/core-runtime/demo-company-profiles';
import { and, eq, inArray, or } from 'drizzle-orm';
import { DateTime, Effect, Predicate } from 'effect';

import { AuthDatabase } from './db/client.ts';
import { user } from './db/schema.ts';
import type { AuthDatabaseExecutor } from './db/types.ts';

interface RentalAccountProfile {
  readonly authUserId: string;
  readonly displayName: string;
  readonly email: string;
  readonly legacyDisplayName: string;
  readonly legacyEmail: string;
  readonly principalId: string;
}
interface AuthBrandRow {
  readonly email: string;
  readonly id: string;
  readonly name: string;
}
type AuthTransaction = Parameters<Parameters<AuthDatabaseExecutor['transaction']>[0]>[0];
const conflict = () =>
  new IdentityLifecycleConflictError({
    code: 'identity_lifecycle_conflict',
    reason: 'The synthetic rental account identities conflict with the reviewed rebrand',
  });
const unavailable = (cause: unknown) =>
  Object.defineProperty(
    new IdentityPersistenceUnavailableError({
      code: 'identity_persistence_unavailable',
      reason: 'Synthetic rental account branding could not be reconciled',
    }),
    'cause',
    { configurable: true, value: cause },
  );
const matchesProfile = (rows: readonly AuthBrandRow[], profile: RentalAccountProfile) => {
  const row = rows.find(({ id }) => id === profile.authUserId);
  return (
    row !== undefined &&
    (row.email === profile.legacyEmail || row.email === profile.email) &&
    (row.name === profile.legacyDisplayName || row.name === profile.displayName)
  );
};

/** Runs only after the authorized Core demo-company Action; Auth owns its private user rows. */
export const rebrandRentalDemoAccounts = Effect.fn('RentalDemoBrand.reconcileAuthAccounts')(
  function* reconcileAuthAccounts(tenantId: string) {
    if (tenantId !== demoCompanyTenantId) {
      return yield* new IdentityTargetInvalidError({
        code: 'identity_target_invalid',
        reason: 'Rental demo branding belongs only to the fixed synthetic demo tenant',
      });
    }
    const resolver = yield* PrincipalResolver;
    // Resolve the retained provider subjects through Core; stage may use non-fixture Auth IDs.
    const profiles = yield* Effect.forEach(
      rentalDemoBrandProfiles,
      (profile) =>
        resolver.resolveBetterAuthUserForPrincipal({ principalId: profile.principalId, tenantId }).pipe(
          Effect.map((authUserId): RentalAccountProfile => ({ ...profile, authUserId })),
          Effect.mapError(unavailable),
        ),
      { concurrency: 1 },
    );
    if (new Set(profiles.map(({ authUserId }) => authUserId)).size !== profiles.length) {
      return yield* conflict();
    }
    const { executor } = yield* AuthDatabase;
    const updatedAt = yield* DateTime.nowAsDate;
    return yield* executor
      .transaction(
        Effect.fn('RentalDemoBrand.renameAuthUsers')(function* renameKnownRentalAccounts(transaction: AuthTransaction) {
          // Include target-address collisions, then lock and validate the whole set before any write.
          const rows = yield* transaction
            .select({ email: user.email, id: user.id, name: user.name })
            .from(user)
            .where(
              or(
                inArray(
                  user.id,
                  profiles.map(({ authUserId }) => authUserId),
                ),
                inArray(
                  user.email,
                  profiles.map(({ email }) => email),
                ),
              ),
            )
            .for('update');
          if (rows.length !== profiles.length || profiles.some((profile) => !matchesProfile(rows, profile))) {
            return yield* conflict();
          }
          const renamed = yield* Effect.reduce(
            profiles,
            () => 0,
            Effect.fn('RentalDemoBrand.renameAuthUser')(function* renameAuthUser(
              count: number,
              profile: RentalAccountProfile,
            ) {
              const row = rows.find(({ id }) => id === profile.authUserId);
              if (row?.email === profile.email && row.name === profile.displayName) {
                return count;
              }
              const updated = yield* transaction
                .update(user)
                .set({ email: profile.email, name: profile.displayName, updatedAt })
                .where(and(eq(user.id, profile.authUserId), eq(user.email, row?.email ?? '')))
                .returning({ id: user.id });
              if (updated.length !== 1) {
                return yield* conflict();
              }
              return count + 1;
            }),
          );
          return { renamed };
        }),
      )
      .pipe(
        Effect.mapError((error) =>
          Predicate.isTagged(error, 'IdentityLifecycleConflictError') ? error : unavailable(error),
        ),
      );
  },
);
