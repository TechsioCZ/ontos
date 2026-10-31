import { and, eq, inArray } from 'drizzle-orm';
import { Effect } from 'effect';

import {
  IdentityLifecycleConflictError,
  IdentityPersistenceUnavailableError,
  IdentityTargetInvalidError,
} from '../auth/principal-management-errors.ts';
import { principals } from '../db/schema.ts';
import type { ScopedTransactionExecutor } from '../db/scoped-transaction.ts';
import { demoCompanyTenantId } from './demo-company-profiles.ts';
import { rentalDemoBrandProfiles } from './demo-rental-brand-profiles.ts';

const unavailable = (cause: unknown) =>
  Object.defineProperty(
    new IdentityPersistenceUnavailableError({
      code: 'identity_persistence_unavailable',
      reason: 'Synthetic rental principal names could not be reconciled',
    }),
    'cause',
    { configurable: true, value: cause },
  );

/** Core-owned labels change inside the audited demo-company Action, never from Auth SQL. */
export const rebrandRentalDemoPrincipals = Effect.fn('RentalDemoBrand.reconcilePrincipalNames')(
  function* reconcilePrincipalNames(
    transaction: Pick<ScopedTransactionExecutor, 'select' | 'update'>,
    tenantId: string,
  ) {
    if (tenantId !== demoCompanyTenantId) {
      return yield* new IdentityTargetInvalidError({
        code: 'identity_target_invalid',
        reason: 'Rental principal branding belongs only to the fixed synthetic demo tenant',
      });
    }
    const rows = yield* transaction
      .select({ displayName: principals.displayName, kind: principals.kind, principalId: principals.principalId })
      .from(principals)
      .where(
        and(
          eq(principals.tenantId, tenantId),
          inArray(
            principals.principalId,
            rentalDemoBrandProfiles.map(({ principalId }) => principalId),
          ),
        ),
      )
      .for('update')
      .pipe(Effect.mapError(unavailable));
    if (
      rows.some((row) => {
        const profile = rentalDemoBrandProfiles.find(({ principalId }) => principalId === row.principalId);
        return (
          profile === undefined ||
          row.kind !== 'human' ||
          (row.displayName !== profile.legacyDisplayName && row.displayName !== profile.displayName)
        );
      })
    ) {
      return yield* new IdentityLifecycleConflictError({
        code: 'identity_lifecycle_conflict',
        reason: 'Synthetic rental principal names differ from the reviewed rebrand',
      });
    }
    const renamed = yield* Effect.reduce(
      rentalDemoBrandProfiles,
      () => 0,
      Effect.fn('RentalDemoBrand.renamePrincipal')(function* renamePrincipal(
        count: number,
        profile: (typeof rentalDemoBrandProfiles)[number],
      ) {
        const row = rows.find(({ principalId }) => principalId === profile.principalId);
        if (row === undefined || row.displayName === profile.displayName) {
          return count;
        }
        const changed = yield* transaction
          .update(principals)
          .set({ displayName: profile.displayName })
          .where(
            and(
              eq(principals.tenantId, tenantId),
              eq(principals.principalId, profile.principalId),
              eq(principals.displayName, profile.legacyDisplayName),
            ),
          )
          .returning({ principalId: principals.principalId })
          .pipe(Effect.mapError(unavailable));
        if (changed.length !== 1) {
          return yield* new IdentityLifecycleConflictError({
            code: 'identity_lifecycle_conflict',
            reason: 'Synthetic rental principal changed during its rebrand',
          });
        }
        return count + 1;
      }),
    );
    return { inspected: rows.length, renamed };
  },
);
