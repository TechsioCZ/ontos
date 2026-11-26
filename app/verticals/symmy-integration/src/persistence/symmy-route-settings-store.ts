/**
 * The route data a route's runtime readers depend on besides the route row: the retention policy of the work a write
 * route admits and the price read source of a `priceLists` read route. Both are tenant rows (RLS) keyed by the route,
 * written with the route by `integration.symmy.manage-symmy-routes` and read by the admission, the retention Action and
 * the route context read.
 */
import type { ScopedTransactionExecutor } from '@app/core-runtime';
import { PriceSourceSystemSchema } from '@app/pricing-contracts/domain/price-source-provenance';
import type { PriceSourceSystem } from '@app/pricing-contracts/domain/price-source-provenance';
import { and, eq, isNotNull, or, sql } from 'drizzle-orm';
import { Effect, Option, Schema } from 'effect';

import { SymmyJobRetentionPolicySchema } from '../../shared/domain/symmy-job-retention.ts';
import type { SymmyJobRetentionPolicy } from '../../shared/domain/symmy-job-retention.ts';
import { symmyRoutePriceReadSources, symmyRouteRetentionPolicies } from '../db/schema.ts';

/** The statements the settings need of a scoped owner transaction. */
export type SymmyRouteSettingsTransaction = Pick<ScopedTransactionExecutor, 'insert' | 'select' | 'update'>;

export class SymmyRouteSettingsUnavailable extends Schema.TaggedError<SymmyRouteSettingsUnavailable>()(
  'SymmyRouteSettingsUnavailable',
  { reason: Schema.String },
) {}
const unavailable = (reason: string) => () => new SymmyRouteSettingsUnavailable({ reason });

type RetentionRow = typeof symmyRouteRetentionPolicies.$inferSelect;
const decodePolicy = Schema.decodeUnknownEffect(SymmyJobRetentionPolicySchema);
const policyOf = (row: RetentionRow) => {
  const policy = {
    governanceLegalEntityId: row.governanceLegalEntityId,
    policyId: row.policyId,
    retentionMs: row.retentionMs,
    revision: row.revision,
    routeId: row.routeId,
    targetLegalEntityId: row.targetLegalEntityId,
    tenantId: row.tenantId,
  };
  if (row.routeFamily !== null) {
    Object.assign(policy, { routeFamily: row.routeFamily });
  }
  return decodePolicy(policy).pipe(
    Effect.mapError(unavailable(`Retention policy ${row.policyId}@${row.revision} is invalid`)),
  );
};

/**
 * The retention policies that can apply to one route of the Tenant: the route's own, and the standing family policies,
 * which `symmyRetentionPolicyMatchesRoute` matches to a route by its enrolled source.
 */
export const readSymmyRetentionPolicies = Effect.fn('SymmyRouteSettings.readRetentionPolicies')(function* read(
  transaction: SymmyRouteSettingsTransaction,
  route: { readonly routeId: string; readonly tenantId: string },
) {
  const rows = yield* transaction
    .select()
    .from(symmyRouteRetentionPolicies)
    .where(
      and(
        eq(symmyRouteRetentionPolicies.tenantId, route.tenantId),
        or(eq(symmyRouteRetentionPolicies.routeId, route.routeId), isNotNull(symmyRouteRetentionPolicies.routeFamily)),
      ),
    )
    .pipe(Effect.mapError(unavailable('The retention policies could not be read')));
  return yield* Effect.forEach(rows, (row) => policyOf(row), { concurrency: 1 });
});

/**
 * Records one route retention policy. A policy revision never changes: recording the same one again is a no-op, and a
 * different policy under the same id and revision is refused.
 */
export const writeSymmyRetentionPolicy = Effect.fn('SymmyRouteSettings.writeRetentionPolicy')(function* write(
  transaction: SymmyRouteSettingsTransaction,
  policy: SymmyJobRetentionPolicy,
) {
  const row = {
    governanceLegalEntityId: policy.governanceLegalEntityId,
    policyId: policy.policyId,
    retentionMs: policy.retentionMs,
    revision: policy.revision,
    routeFamily: policy.routeFamily ?? null,
    routeId: policy.routeId,
    targetLegalEntityId: Option.getOrNull(policy.targetLegalEntityId),
    tenantId: policy.tenantId,
  };
  yield* transaction
    .insert(symmyRouteRetentionPolicies)
    .values(row)
    .onConflictDoNothing()
    .pipe(Effect.mapError(unavailable('The retention policy could not be written')));
  const [stored] = yield* transaction
    .select()
    .from(symmyRouteRetentionPolicies)
    .where(
      and(
        eq(symmyRouteRetentionPolicies.tenantId, row.tenantId),
        eq(symmyRouteRetentionPolicies.routeId, row.routeId),
        eq(symmyRouteRetentionPolicies.policyId, row.policyId),
        eq(symmyRouteRetentionPolicies.revision, row.revision),
      ),
    )
    .limit(1)
    .pipe(Effect.mapError(unavailable('The retention policy could not be read back')));
  return (
    stored !== undefined &&
    stored.governanceLegalEntityId === row.governanceLegalEntityId &&
    stored.retentionMs === row.retentionMs &&
    stored.routeFamily === row.routeFamily &&
    stored.targetLegalEntityId === row.targetLegalEntityId
  );
});

const decodeSourceSystem = Schema.decodeUnknownEffect(PriceSourceSystemSchema);

/** The price source system of one `priceLists` read route, when one is set. */
export const readSymmyPriceReadSource = Effect.fn('SymmyRouteSettings.readPriceReadSource')(function* read(
  transaction: SymmyRouteSettingsTransaction,
  route: { readonly routeId: string; readonly tenantId: string },
) {
  const [row] = yield* transaction
    .select({
      ownerModuleId: symmyRoutePriceReadSources.ownerModuleId,
      sourceSystemRef: symmyRoutePriceReadSources.sourceSystemRef,
    })
    .from(symmyRoutePriceReadSources)
    .where(
      and(
        eq(symmyRoutePriceReadSources.tenantId, route.tenantId),
        eq(symmyRoutePriceReadSources.routeId, route.routeId),
      ),
    )
    .limit(1)
    .pipe(Effect.mapError(unavailable('The price read source could not be read')));
  if (row === undefined) {
    return Option.none<PriceSourceSystem>();
  }
  return Option.some(
    yield* decodeSourceSystem(row).pipe(Effect.mapError(unavailable('The price read source is invalid'))),
  );
});

/** Sets the price source system a `priceLists` read route pages its prices from. */
export const writeSymmyPriceReadSource = Effect.fn('SymmyRouteSettings.writePriceReadSource')(function* write(
  transaction: SymmyRouteSettingsTransaction,
  route: { readonly routeId: string; readonly tenantId: string },
  source: PriceSourceSystem,
) {
  yield* transaction
    .insert(symmyRoutePriceReadSources)
    .values({ ...source, routeId: route.routeId, tenantId: route.tenantId })
    .onConflictDoUpdate({
      set: { ownerModuleId: source.ownerModuleId, sourceSystemRef: source.sourceSystemRef, updatedAt: sql`now()` },
      target: [symmyRoutePriceReadSources.tenantId, symmyRoutePriceReadSources.routeId],
    })
    .pipe(Effect.mapError(unavailable('The price read source could not be written')));
});
