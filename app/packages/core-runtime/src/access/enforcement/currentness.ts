import { and, eq, isNull, or } from 'drizzle-orm';
import { Effect, Option } from 'effect';

import { CoreDatabase } from '../../db/client.ts';
import { installOperationalScope } from '../../db/scoped-transaction.ts';
import { DatabaseIdentityEnrollmentContext } from '../../db/database-identities.ts';
import type { DatabaseIdentityEnrollment } from '../../db/database-identities.ts';
import type { CoreDatabaseExecutor, CoreTransaction } from '../../db/types.ts';
import { accessScopeFences, accessScopes } from '../../db/schema.ts';
import type { OperationalScope } from '../../operations/context.ts';
import type { LegalEntityScope } from '../../operations/legal-entity-scope.ts';
import { accessDecisionUnavailable } from '../decision/errors.ts';
import { lockActionAccessFence } from '../approvals/action-access-fence.ts';

export interface AccessAuthorityRevision {
  readonly revision: number;
  readonly scopeId: string;
}

export interface AccessAuthorityCurrentness {
  readonly read: (
    scope: OperationalScope,
    legalEntityScope: LegalEntityScope,
    administrative: boolean,
    transaction?: CoreTransaction,
  ) => Effect.Effect<readonly AccessAuthorityRevision[], ReturnType<typeof accessDecisionUnavailable>>;
}

/**
 * Persisted projection revisions, not an invented snapshot. The tenant fence covers the whole
 * projection; a company operation also pins its own scope. Writer acquisition AND release increment
 * revision, so Ready→Changing→Ready cannot pass for the same authority after preparation.
 */
const readRevisionInTransaction = Effect.fn('AccessAuthority.readRevisionInTransaction')(
  function* readRevisionInTransaction(
    current: CoreTransaction,
    scope: OperationalScope,
    legalEntityScope: LegalEntityScope,
    administrative: boolean,
  ) {
    const company = !administrative && legalEntityScope === 'required' ? scope.legalEntityId : undefined;
    if (!administrative && legalEntityScope === 'required' && company === undefined) {
      return yield* accessDecisionUnavailable('Authority preparation requires the trusted company');
    }
    yield* lockActionAccessFence(current, scope, legalEntityScope, administrative).pipe(
      Effect.mapError((cause) => accessDecisionUnavailable('The prepared authority fence could not be locked', cause)),
    );
    const rows = yield* current
      .select({
        revision: accessScopeFences.revision,
        scopeId: accessScopes.scopeId,
        state: accessScopeFences.state,
      })
      .from(accessScopes)
      .innerJoin(
        accessScopeFences,
        and(eq(accessScopeFences.tenantId, accessScopes.tenantId), eq(accessScopeFences.scopeId, accessScopes.scopeId)),
      )
      .where(
        and(
          eq(accessScopes.tenantId, scope.tenantId),
          or(
            isNull(accessScopes.legalEntityId),
            company === undefined ? undefined : eq(accessScopes.legalEntityId, company),
          ),
        ),
      );
    if (
      rows.length !== (company === undefined ? 1 : 2) ||
      rows.some((row) => row.state !== 'Ready' || !Number.isSafeInteger(row.revision) || row.revision < 1)
    ) {
      return yield* accessDecisionUnavailable('The complete persisted authority revision is not Ready');
    }
    return rows
      .map(({ revision, scopeId }) => Object.freeze({ revision, scopeId }))
      .toSorted((left, right) => left.scopeId.localeCompare(right.scopeId));
  },
);

export const makeAccessAuthorityCurrentness = (database: {
  readonly enrollment: DatabaseIdentityEnrollment;
  readonly executor: CoreDatabaseExecutor;
}): AccessAuthorityCurrentness => {
  const read: AccessAuthorityCurrentness['read'] = Effect.fn('AccessAuthority.readCurrentness')(
    function* readCurrentness(scope, legalEntityScope, administrative, transaction) {
      const effect =
        transaction === undefined
          ? database.executor.transaction((current) =>
              installOperationalScope(current, scope, database.enrollment).pipe(
                Effect.andThen(() => readRevisionInTransaction(current, scope, legalEntityScope, administrative)),
              ),
            )
          : readRevisionInTransaction(transaction, scope, legalEntityScope, administrative);
      return yield* effect.pipe(
        Effect.mapError((cause) => accessDecisionUnavailable('Authority currentness could not be read', cause)),
      );
    },
  );
  return Object.freeze({ read });
};

/** The runtime's persisted currentness: the enrolled Core database the surrounding layers provide. */
export const AccessAuthorityCurrentnessLive = Effect.gen(function* accessAuthorityCurrentnessFromLayers() {
  const [database, enrollment] = yield* Effect.all([CoreDatabase, DatabaseIdentityEnrollmentContext], {
    concurrency: 2,
  });
  return makeAccessAuthorityCurrentness({ enrollment, executor: database.executor });
});

export const sameAuthorityRevision = (
  left: readonly AccessAuthorityRevision[],
  right: readonly AccessAuthorityRevision[],
): boolean =>
  left.length > 0 &&
  left.length === right.length &&
  left.every((entry, index) => {
    const other = Option.fromUndefinedOr(right[index]);
    return Option.isSome(other) && entry.scopeId === other.value.scopeId && entry.revision === other.value.revision;
  });
