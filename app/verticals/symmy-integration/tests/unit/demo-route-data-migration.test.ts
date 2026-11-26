import { readFileSync } from 'node:fs';

import { Option, Schema } from 'effect';
import { describe, expect, it } from 'effect-rstest';

import { SymmyJobRetentionPolicySchema } from '../../shared/domain/symmy-job-retention.ts';

/**
 * The AKROS stage demo's route retention and price read source as `app/zerops.yaml` configured them before they became
 * route data (ONTOS_SYMMY_JOB_RETENTION_POLICIES, ONTOS_SYMMY_PRICE_READ_SOURCES). The migration must write the same.
 */
const formerRetention =
  '[{"policyId":"akros-symmy-products","revision":"v1","tenantId":"bceaa540-13eb-5508-9ac0-9ed7e40a2ee9","routeId":"1a24b716-0542-40d5-8906-c78554b7436d","governanceLegalEntityId":"c0c78a3e-6e2a-57e0-9d0d-86253499fee7","targetLegalEntityId":"c0c78a3e-6e2a-57e0-9d0d-86253499fee7","retentionMs":2592000000},{"policyId":"akros-symmy-stock","revision":"v1","tenantId":"bceaa540-13eb-5508-9ac0-9ed7e40a2ee9","routeId":"042ef863-a837-48d6-81de-59a239148312","governanceLegalEntityId":"c0c78a3e-6e2a-57e0-9d0d-86253499fee7","targetLegalEntityId":null,"retentionMs":2592000000},{"policyId":"akros-symmy-price-lists","revision":"v1","tenantId":"bceaa540-13eb-5508-9ac0-9ed7e40a2ee9","routeId":"9e355544-4242-4704-a9d3-0ef0832fc328","governanceLegalEntityId":"c0c78a3e-6e2a-57e0-9d0d-86253499fee7","targetLegalEntityId":"c0c78a3e-6e2a-57e0-9d0d-86253499fee7","retentionMs":2592000000},{"policyId":"akros-symmy-prices","revision":"v1","tenantId":"bceaa540-13eb-5508-9ac0-9ed7e40a2ee9","routeId":"3276fa39-f868-4be3-942c-501a6996a74a","governanceLegalEntityId":"c0c78a3e-6e2a-57e0-9d0d-86253499fee7","targetLegalEntityId":"c0c78a3e-6e2a-57e0-9d0d-86253499fee7","retentionMs":2592000000},{"policyId":"akros-symmy-customer-groups","revision":"v1","tenantId":"bceaa540-13eb-5508-9ac0-9ed7e40a2ee9","routeId":"f637a6ec-865b-43bc-9c28-57783757f367","governanceLegalEntityId":"c0c78a3e-6e2a-57e0-9d0d-86253499fee7","targetLegalEntityId":"c0c78a3e-6e2a-57e0-9d0d-86253499fee7","retentionMs":2592000000},{"policyId":"akros-symmy-stock-source-v1","revision":"v1","tenantId":"bceaa540-13eb-5508-9ac0-9ed7e40a2ee9","routeId":"20f8cb1e-ecc1-8fda-912d-699274afc835","governanceLegalEntityId":"c0c78a3e-6e2a-57e0-9d0d-86253499fee7","targetLegalEntityId":null,"retentionMs":2592000000},{"policyId":"akros-symmy-customers","revision":"v1","tenantId":"bceaa540-13eb-5508-9ac0-9ed7e40a2ee9","routeId":"5158ef08-7315-57e1-a9ed-b0fef8cd9ac1","governanceLegalEntityId":"c0c78a3e-6e2a-57e0-9d0d-86253499fee7","targetLegalEntityId":"c0c78a3e-6e2a-57e0-9d0d-86253499fee7","retentionMs":2592000000},{"policyId":"akros-symmy-memberships","revision":"v1","tenantId":"bceaa540-13eb-5508-9ac0-9ed7e40a2ee9","routeId":"f637a6ec-865b-43bc-9c28-57783757f367","governanceLegalEntityId":"c0c78a3e-6e2a-57e0-9d0d-86253499fee7","targetLegalEntityId":"c0c78a3e-6e2a-57e0-9d0d-86253499fee7","retentionMs":2592000000,"routeFamily":"DEMO_GROUP_MEMBERSHIP"}]';
const formerPriceReadSource = {
  legalEntityId: 'c0c78a3e-6e2a-57e0-9d0d-86253499fee7',
  routeId: '6d1d4cdb-72f9-4485-8c07-5806ec9468fe',
  sourceSystem: { ownerModuleId: 'external.symmy', sourceSystemRef: 'symmy-akros' },
  tenantId: 'bceaa540-13eb-5508-9ac0-9ed7e40a2ee9',
} as const;

const migration = readFileSync(
  new URL('../../drizzle/20261126101057_symmy-runtime-route-data/migration.sql', import.meta.url),
  'utf-8',
);
const tenantOf = (statement: string) => {
  const { tenant } = /r\.tenant_id = '(?<tenant>[0-9a-f-]{36})'::uuid/u.exec(statement)?.groups ?? {};
  return tenant;
};
const statementOf = (table: string) =>
  migration
    .split('--> statement-breakpoint')
    .find((statement) => statement.includes(`INSERT INTO symmy_integration.${table}`)) ?? '';

describe('the demo route data migration', () => {
  it('writes every former retention policy of the demo routes, unchanged', () => {
    const former = Schema.decodeUnknownSync(Schema.fromJsonString(Schema.Array(SymmyJobRetentionPolicySchema)))(
      formerRetention,
    );
    const statement = statementOf('route_retention_policies');
    const { governance } =
      /SELECT r\.tenant_id, r\.route_id, p\.policy_id, 'v1', '(?<governance>[0-9a-f-]{36})'::uuid/u.exec(statement)
        ?.groups ?? {};
    const { retention } = /END, (?<retention>\d+), p\.route_family/u.exec(statement)?.groups ?? {};
    const rows = [
      ...statement.matchAll(
        /\('(?<routeId>[0-9a-f-]{36})'::uuid, '(?<policyId>[a-z0-9-]+)', (?<companyTarget>true|false), (?<family>NULL(?:::text)?|'[A-Z_]+')\)/gu,
      ),
    ].map(({ groups: { companyTarget, family, policyId, routeId } = {} }) => ({
      companyTarget: companyTarget === 'true',
      family: family === undefined || family.startsWith('NULL') ? undefined : family.slice(1, -1),
      policyId,
      routeId,
    }));
    expect(rows).toHaveLength(former.length);
    for (const policy of former) {
      expect(policy.revision).toBe('v1');
      expect(policy.tenantId).toBe(tenantOf(statement));
      expect(policy.governanceLegalEntityId).toBe(governance);
      expect(String(policy.retentionMs)).toBe(retention);
      expect(rows).toContainEqual({
        companyTarget: Option.isSome(policy.targetLegalEntityId),
        family: policy.routeFamily,
        policyId: policy.policyId,
        routeId: policy.routeId,
      });
      expect(Option.getOrElse(policy.targetLegalEntityId, () => governance)).toBe(governance);
    }
  });

  it('writes the former price read source of the demo priceLists route', () => {
    const statement = statementOf('route_price_read_sources');
    const route = formerPriceReadSource;
    expect(statement).toContain(
      `SELECT r.tenant_id, r.route_id, '${route.sourceSystem.ownerModuleId}', '${route.sourceSystem.sourceSystemRef}'`,
    );
    expect(statement).toContain(`r.route_id = '${route.routeId}'::uuid`);
    expect(statement).toContain(`r.legal_entity_id = '${route.legalEntityId}'::uuid`);
    expect(tenantOf(statement)).toBe(route.tenantId);
  });
});
