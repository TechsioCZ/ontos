import { and, eq, isNull, or } from 'drizzle-orm';
import { Data, Duration, Effect, Option, Predicate } from 'effect';

import { CoreDatabase } from '../../db/client.ts';
import { installOperationalScope } from '../../db/scoped-transaction.ts';
import { DatabaseIdentityEnrollmentContext } from '../../db/database-identities.ts';
import type { DatabaseIdentityEnrollment } from '../../db/database-identities.ts';
import type { CoreDatabaseExecutor, CoreTransaction } from '../../db/types.ts';
import { accessScopeFences, accessScopes } from '../../db/schema.ts';
import type { OperationalScope } from '../../operations/context.ts';
import type { LegalEntityScope } from '../../operations/legal-entity-scope.ts';
import { accessDecisionUnavailable } from '../decision/errors.ts';
import type { AccessDecisionUnavailable } from '../decision/errors.ts';
import { isAccessFenceChanging, lockActionAccessFence } from '../approvals/action-access-fence.ts';

export interface AccessAuthorityRevision {
  readonly revision: number;
  readonly scopeId: string;
}

/**
 * An access writer holds the persisted authority (its fence is Changing) or moved its revision while a preparation read
 * it. The authority is being rewritten, not missing: the writer gives the fence back within seconds.
 */
export class AccessAuthorityChanging extends Data.TaggedError('AccessAuthorityChanging')<{
  readonly cause?: unknown;
  readonly reason: string;
}> {}

/**
 * How long a protected Action's preparation waits for a writer to give the fence back before it answers the 503. Every
 * reconcile closes the tenant's fence, an unchanged one too, and a deploy's activation and grant steps run them while
 * the previous host still serves: Akros reconciles take 3.5–6 s on stage and the longest tenant 17 s. The wait stays
 * under the 30 s an owner response may take.
 */
export const ACTION_AUTHORITY_READY_WAIT = Duration.seconds(20);

export interface AccessAuthorityCurrentness {
  readonly read: (
    scope: OperationalScope,
    legalEntityScope: LegalEntityScope,
    administrative: boolean,
    transaction?: CoreTransaction,
  ) => Effect.Effect<readonly AccessAuthorityRevision[], AccessDecisionUnavailable | AccessAuthorityChanging>;
  /** How long a preparation outside any transaction waits for a Changing authority; absent, it does not wait. */
  readonly readyWait?: Duration.Duration;
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
      Effect.mapError((cause) =>
        isAccessFenceChanging(cause)
          ? new AccessAuthorityChanging({ cause, reason: 'An access writer holds the prepared authority fence' })
          : accessDecisionUnavailable('The prepared authority fence could not be locked', cause),
      ),
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

export const makeAccessAuthorityCurrentness = (
  database: {
    readonly enrollment: DatabaseIdentityEnrollment;
    readonly executor: CoreDatabaseExecutor;
  },
  readyWait?: Duration.Duration,
): AccessAuthorityCurrentness => {
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
        Effect.mapError((cause) =>
          Predicate.isTagged(cause, 'AccessAuthorityChanging')
            ? cause
            : accessDecisionUnavailable('Authority currentness could not be read', cause),
        ),
      );
    },
  );
  return Object.freeze(readyWait === undefined ? { read } : { read, readyWait });
};

/**
 * The runtime's persisted currentness: the enrolled Core database the surrounding layers provide. Its Actions wait for a
 * Changing authority (`ACTION_AUTHORITY_READY_WAIT`).
 */
export const AccessAuthorityCurrentnessLive = Effect.gen(function* accessAuthorityCurrentnessFromLayers() {
  const [database, enrollment] = yield* Effect.all([CoreDatabase, DatabaseIdentityEnrollmentContext], {
    concurrency: 2,
  });
  return makeAccessAuthorityCurrentness({ enrollment, executor: database.executor }, ACTION_AUTHORITY_READY_WAIT);
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
