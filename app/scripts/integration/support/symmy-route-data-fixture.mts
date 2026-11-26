import type { PgClient } from '@effect/sql-pg';
import { Effect } from 'effect';

/** One retention policy a fixture route pins: route data the Symmy owner admits and purges its jobs against. */
export interface SymmyRetentionFixture {
  readonly governanceLegalEntityId: string;
  readonly policyId: string;
  readonly retentionMs: number;
  readonly revision: string;
  readonly routeId: string;
  readonly targetLegalEntityId: string | null;
  readonly tenantId: string;
}

/**
 * Records the retention policies of routes the fixture has already enrolled, as a tenant administrator's enable does.
 * A policy row names its route, so it is written after the route.
 */
export const recordSymmyRetentionPolicies = (admin: PgClient.PgClient, policies: readonly SymmyRetentionFixture[]) =>
  Effect.forEach(
    policies,
    (policy) =>
      admin`insert into symmy_integration.route_retention_policies
        (tenant_id,route_id,policy_id,revision,governance_legal_entity_id,target_legal_entity_id,retention_ms)
        values(${policy.tenantId},${policy.routeId},${policy.policyId},${policy.revision},
          ${policy.governanceLegalEntityId},${policy.targetLegalEntityId},${policy.retentionMs})`,
    { concurrency: 1, discard: true },
  );

/** Records the price source system a fixture's `priceLists` read route pages its prices from. */
export const recordSymmyPriceReadSource = (
  admin: PgClient.PgClient,
  source: {
    readonly ownerModuleId: string;
    readonly routeId: string;
    readonly sourceSystemRef: string;
    readonly tenantId: string;
  },
) =>
  admin`insert into symmy_integration.route_price_read_sources(tenant_id,route_id,owner_module_id,source_system_ref)
    values(${source.tenantId},${source.routeId},${source.ownerModuleId},${source.sourceSystemRef})
    on conflict (tenant_id,route_id) do update
      set owner_module_id=excluded.owner_module_id,source_system_ref=excluded.source_system_ref,updated_at=now()`;
