import { and, eq, isNull } from 'drizzle-orm';
import { Effect } from 'effect';

import { accessScopeFences, accessScopes } from '../../db/schema.ts';
import type { CoreTransaction } from '../../db/types.ts';
import type { OperationalScope } from '../../operations/context.ts';
import { intentUnavailable } from '../intent/errors.ts';
import { durable } from '../intent/persistence.ts';

/** Registration changes serialize with the tenant fence every prepared Action holds through commit. */
export const lockWorkloadAuthority = Effect.fn('WorkloadAuthority.lockFence')(function* lockWorkloadAuthorityFence(
  transaction: CoreTransaction,
  scope: OperationalScope,
) {
  const rows = yield* transaction
    .select({ state: accessScopeFences.state })
    .from(accessScopeFences)
    .innerJoin(
      accessScopes,
      and(eq(accessScopes.tenantId, accessScopeFences.tenantId), eq(accessScopes.scopeId, accessScopeFences.scopeId)),
    )
    .where(and(eq(accessScopeFences.tenantId, scope.tenantId), isNull(accessScopes.legalEntityId)))
    .for('update', { of: accessScopeFences })
    .pipe(durable(new Set()));
  if (rows.length !== 1 || rows[0]?.state !== 'Ready') {
    return yield* intentUnavailable('The workload authority has no ready tenant fence');
  }
  return yield* Effect.void;
});
