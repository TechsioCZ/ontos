import { and, eq } from 'drizzle-orm';
import { DateTime, Effect, Option } from 'effect';

import { legalEntities, principalCompanyMemberships, principals, tenants } from '../db/schema.ts';
import type { ScopedTransactionExecutor } from '../db/scoped-transaction.ts';
import { isCompanyAffiliationValid } from '../permissions/company-membership.ts';
import type {
  CompanyAffiliation,
  CompanyMembership,
  CompanyMembershipStatus,
} from '../permissions/company-membership.ts';
import type { PrincipalRef } from '../permissions/principal-ref.ts';
import {
  IdentityLifecycleConflictError,
  IdentityPersistenceUnavailableError,
  IdentityTargetInvalidError,
} from './principal-management-errors.ts';

export interface SetCompanyMembershipInput {
  readonly affiliation: Option.Option<CompanyAffiliation>;
  /** Zero creates an explicitly selected membership; positive revisions update that exact row. */
  readonly expectedRevision: number;
  readonly principalRef: PrincipalRef;
  readonly status: CompanyMembershipStatus;
}

const invalid = (reason: string) => new IdentityTargetInvalidError({ code: 'identity_target_invalid', reason });
const conflict = () =>
  new IdentityLifecycleConflictError({
    code: 'identity_lifecycle_conflict',
    reason: 'The company membership changed concurrently',
  });
const unavailable = (cause: unknown) =>
  Object.defineProperty(
    new IdentityPersistenceUnavailableError({
      code: 'identity_persistence_unavailable',
      reason: 'Company membership could not be persisted',
    }),
    'cause',
    { value: cause },
  );

/** Only the owning audited Action receives this transaction-bound writer. It never creates a principal or a role. */
export const companyMembershipManagementFromTransaction = (
  transaction: Pick<ScopedTransactionExecutor, 'insert' | 'select' | 'update' | 'scope'>,
) => ({
  set: Effect.fn('CompanyMembershipManagement.set')(function* setCompanyMembership(input: SetCompanyMembershipInput) {
    const { legalEntityId, tenantId } = transaction.scope;
    if (legalEntityId === undefined || input.principalRef.tenantId !== tenantId) {
      return yield* invalid('Membership requires an exact company and a tenant-local PrincipalRef');
    }
    if (!Number.isSafeInteger(input.expectedRevision) || input.expectedRevision < 0) {
      return yield* invalid('Membership requires a nonnegative expected revision');
    }
    const [target] = yield* transaction
      .select({
        companyStatus: legalEntities.status,
        kind: principals.kind,
        principalStatus: principals.status,
        tenantStatus: tenants.status,
      })
      .from(principals)
      .innerJoin(tenants, eq(tenants.tenantId, principals.tenantId))
      .innerJoin(
        legalEntities,
        and(eq(legalEntities.tenantId, principals.tenantId), eq(legalEntities.legalEntityId, legalEntityId)),
      )
      .where(and(eq(principals.tenantId, tenantId), eq(principals.principalId, input.principalRef.principalId)))
      .pipe(Effect.mapError(unavailable));
    const affiliation = Option.getOrNull(input.affiliation);
    if (target === undefined || !isCompanyAffiliationValid(target.kind, affiliation)) {
      return yield* invalid('Membership requires an existing company actor with a valid company affiliation');
    }
    if (target.tenantStatus !== 'active' || target.companyStatus !== 'active') {
      return yield* invalid('Membership cannot be changed in an inactive tenant or company');
    }
    if ((input.status === 'active' || input.status === 'invited') && target.principalStatus !== 'active') {
      return yield* invalid('An inactive principal cannot be invited or activated');
    }
    if (input.expectedRevision === 0 && input.status !== 'active' && input.status !== 'invited') {
      return yield* invalid('A new membership must be explicitly invited or activated');
    }
    const identity = { legalEntityId, principalId: input.principalRef.principalId, tenantId };
    const returned = {
      affiliation: principalCompanyMemberships.affiliation,
      revision: principalCompanyMemberships.revision,
      status: principalCompanyMemberships.status,
    };
    const [saved] = yield* (
      input.expectedRevision === 0
        ? transaction
            .insert(principalCompanyMemberships)
            .values({ ...identity, affiliation, status: input.status })
            .onConflictDoNothing()
            .returning(returned)
        : transaction
            .update(principalCompanyMemberships)
            .set({
              affiliation,
              revision: input.expectedRevision + 1,
              status: input.status,
              updatedAt: yield* DateTime.nowAsDate,
            })
            .where(
              and(
                eq(principalCompanyMemberships.tenantId, tenantId),
                eq(principalCompanyMemberships.legalEntityId, legalEntityId),
                eq(principalCompanyMemberships.principalId, input.principalRef.principalId),
                eq(principalCompanyMemberships.revision, input.expectedRevision),
              ),
            )
            .returning(returned)
    ).pipe(Effect.mapError(unavailable));
    if (saved === undefined) {
      return yield* conflict();
    }
    return {
      affiliation: Option.fromNullishOr(saved.affiliation),
      legalEntityId,
      principalRef: input.principalRef,
      revision: saved.revision,
      status: saved.status,
    } satisfies CompanyMembership;
  }),
});
