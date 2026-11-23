import { and, eq } from 'drizzle-orm';
import { Effect, Option, Schema } from 'effect';

import { WorkloadKeySchema } from '../../authorization/access-declaration.ts';
import { internalWorkloadPrincipalId } from '../../auth/module-credentials.ts';
import {
  accessWorkloadBindings,
  accessWorkloadCompanyBindings,
  legalEntities,
  principals,
  tenants,
} from '../../db/schema.ts';
import type { ScopedTransactionExecutor } from '../../db/scoped-transaction.ts';
import { accessDecisionUnavailable } from '../decision/errors.ts';

const companySourceWriters: ReadonlySet<string> = new Set([
  'party.registry.source-write',
  'commerce.customer-context.source-write',
]);

/**
 * Factual enrollment only. A unique legacy system binding retains its tenant-wide identity semantics.
 * Only the two native customer source writers also admit Core's platform-created company service enrollment.
 * No authentication context, binding or permission is constructed here.
 */
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
    if (rows.length === 1 || !companySourceWriters.has(key) || transaction.scope.legalEntityId === undefined) {
      return Option.fromUndefinedOr(rows[0]);
    }
    const { tenantId, legalEntityId } = transaction.scope;
    const serviceRows = yield* transaction
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
      .innerJoin(
        accessWorkloadCompanyBindings,
        and(
          eq(accessWorkloadCompanyBindings.tenantId, accessWorkloadBindings.tenantId),
          eq(accessWorkloadCompanyBindings.workloadBindingId, accessWorkloadBindings.bindingId),
        ),
      )
      .innerJoin(
        legalEntities,
        and(
          eq(legalEntities.tenantId, accessWorkloadCompanyBindings.tenantId),
          eq(legalEntities.legalEntityId, accessWorkloadCompanyBindings.legalEntityId),
        ),
      )
      .where(
        and(
          eq(accessWorkloadBindings.tenantId, tenantId),
          eq(accessWorkloadBindings.workloadKey, key),
          eq(accessWorkloadBindings.status, 'active'),
          eq(principals.kind, 'service'),
          eq(principals.platformRole, 'internal_workload'),
          eq(principals.principalId, internalWorkloadPrincipalId({ tenantId, legalEntityId, workloadKey: key })),
          eq(principals.status, 'active'),
          eq(tenants.status, 'active'),
          eq(accessWorkloadCompanyBindings.legalEntityId, legalEntityId),
          eq(accessWorkloadCompanyBindings.status, 'active'),
          eq(legalEntities.status, 'active'),
        ),
      )
      .limit(2)
      .pipe(
        Effect.mapError((cause) =>
          accessDecisionUnavailable('The company source-writer enrollment could not be read', cause),
        ),
      );
    if (serviceRows.length > 1) {
      return yield* accessDecisionUnavailable('The exact company source workload has an ambiguous enrollment');
    }
    return Option.fromUndefinedOr(serviceRows[0]);
  },
);
