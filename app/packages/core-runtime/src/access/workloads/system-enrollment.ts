import { and, eq } from 'drizzle-orm';
import { Effect, Option, Schema } from 'effect';

import { WorkloadKeySchema } from '../../authorization/access-declaration.ts';
import { accessWorkloadBindings, principals, tenants } from '../../db/schema.ts';
import type { ScopedTransactionExecutor } from '../../db/scoped-transaction.ts';
import { accessDecisionUnavailable } from '../decision/errors.ts';

/** Factual enrollment only. No authentication context or permission is constructed here. */
export const readScopedSystemWorkloadEnrollment = Effect.fn('SystemWorkload.readScopedEnrollment')(
  function* readScopedEnrollment(transaction: ScopedTransactionExecutor, workloadKey: string) {
    const key = yield* Schema.decodeUnknownEffect(WorkloadKeySchema)(workloadKey).pipe(
      Effect.mapError((cause) => accessDecisionUnavailable('The exact system workload key is invalid', cause)),
    );
    const rows = yield* transaction
      .select({ bindingIncarnation: accessWorkloadBindings.incarnation, principalId: principals.principalId })
      .from(accessWorkloadBindings)
      .innerJoin(
        principals,
        and(
          eq(principals.tenantId, accessWorkloadBindings.tenantId),
          eq(principals.principalId, accessWorkloadBindings.principalId),
        ),
      )
      .innerJoin(tenants, eq(tenants.tenantId, principals.tenantId))
      .where(
        and(
          eq(accessWorkloadBindings.tenantId, transaction.scope.tenantId),
          eq(accessWorkloadBindings.workloadKey, key),
          eq(accessWorkloadBindings.status, 'active'),
          eq(principals.kind, 'system'),
          eq(principals.status, 'active'),
          eq(tenants.status, 'active'),
        ),
      )
      .limit(2)
      .pipe(
        Effect.mapError((cause) => accessDecisionUnavailable('The current system enrollment could not be read', cause)),
      );
    if (rows.length > 1) {
      return yield* accessDecisionUnavailable('The exact system workload has an ambiguous enrollment');
    }
    return Option.fromUndefinedOr(rows[0]);
  },
);
