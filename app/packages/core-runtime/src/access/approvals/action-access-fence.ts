import { and, eq, isNull, sql } from 'drizzle-orm';
import { Effect } from 'effect';

import { ActionPermissionCheckError } from '../../actions/errors.ts';
import type { CoreTransaction } from '../../db/types.ts';
import { accessScopes } from '../../db/schema.ts';
import type { OperationalScope } from '../../operations/context.ts';
import type { LegalEntityScope } from '../../operations/legal-entity-scope.ts';

const fenceUnavailable = (cause?: unknown) => {
  const failure = new ActionPermissionCheckError({
    code: 'action_permission_check_failed',
    reason: 'The access authority of this Action could not be pinned to its transaction',
  });
  if (cause !== undefined) {
    Object.defineProperty(failure, 'cause', { value: cause });
  }
  return failure;
};

/** The one access scope of a tenant context (no company) or of one company; anything else is the typed 503. */
const scopeFenceOf = Effect.fn('ActionMandateDispatch.scopeFenceOf')(function* scopeFenceOfEffect(
  transaction: CoreTransaction,
  tenantId: OperationalScope['tenantId'],
  legalEntityId?: OperationalScope['legalEntityId'],
) {
  const scopes = yield* transaction
    .select({ scopeId: accessScopes.scopeId })
    .from(accessScopes)
    .where(
      and(
        eq(accessScopes.tenantId, tenantId),
        legalEntityId === undefined
          ? isNull(accessScopes.legalEntityId)
          : eq(accessScopes.legalEntityId, legalEntityId),
      ),
    )
    .pipe(Effect.mapError((cause) => fenceUnavailable(cause)));
  const [resolved] = scopes;
  return scopes.length === 1 && resolved !== undefined ? resolved.scopeId : yield* fenceUnavailable();
});

/** Holds one scope's fence to commit; only a Ready fence admits, so a Changing writer is a 503. */
const lockScopeFence = Effect.fn('ActionMandateDispatch.lockScopeFence')(function* lockScopeFenceEffect(
  transaction: CoreTransaction,
  tenantId: OperationalScope['tenantId'],
  scopeId: string,
) {
  const fences = yield* transaction
    .execute<{ readonly state: string | null }>(
      sql`select trust.lock_access_scope_fence(${tenantId}::uuid, ${scopeId}::uuid) as state`,
      'objects',
    )
    .pipe(Effect.mapError((cause) => fenceUnavailable(cause)));
  return fences.length === 1 && fences[0]?.state === 'Ready' ? yield* Effect.void : yield* fenceUnavailable();
});

/**
 * The same scope fence the intent/projection writer changes from Ready to Changing. A shared row
 * lock is held to commit: an exclusive writer cannot acquire the fence between the second gate
 * decision and the owner write. Missing/Changing/Unavailable is 503, never an implicit grant.
 * This is not a replacement for the one gate: the runner re-decides while holding this lock.
 *
 * Request identities hold no grant on `core.access_scope_fences`. The lock is taken by the
 * `trust.lock_access_scope_fence` routine, which only reaches a fence of the tenant the transaction's
 * established scope allows. Any SQL failure of either read is the typed 503, never a defect.
 */
export const lockActionAccessFence = Effect.fn('ActionMandateDispatch.lockAccessFence')(
  function* lockActionAccessFenceEffect(
    transaction: CoreTransaction,
    scope: OperationalScope,
    legalEntityScope: LegalEntityScope,
    administrative: boolean,
  ) {
    if (!administrative && legalEntityScope === 'required' && scope.legalEntityId === undefined) {
      return yield* fenceUnavailable();
    }
    const company = !administrative && legalEntityScope === 'required' ? scope.legalEntityId : undefined;
    // The projection writer turns the tenant context's fence to Changing for the whole tenant and projects
    // every company under it, so that is the fence a decision must hold. A company Action also holds its
    // own company's fence, taken second in the writer's order, so neither scope can change under it.
    const tenantFence = yield* scopeFenceOf(transaction, scope.tenantId);
    yield* lockScopeFence(transaction, scope.tenantId, tenantFence);
    return company === undefined
      ? yield* Effect.void
      : yield* lockScopeFence(transaction, scope.tenantId, yield* scopeFenceOf(transaction, scope.tenantId, company));
  },
);
