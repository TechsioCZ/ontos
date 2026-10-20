import { getTableConfig, PgDialect, pgTable, uuid } from 'drizzle-orm/pg-core';
import { expect, it } from 'effect-rstest';

import { gatewayScopedTenantLegalEntityRlsPolicies } from '../../src/db/scoped-transaction.ts';

const dialect = new PgDialect();
const fixture = pgTable(
  'gateway_scope_fixture',
  {
    legalEntityId: uuid('legal_entity_id'),
    tenantId: uuid('tenant_id').notNull(),
  },
  (table) => [
    ...gatewayScopedTenantLegalEntityRlsPolicies(
      'fixture',
      table.tenantId,
      table.legalEntityId,
      'party_registry_runtime',
    ),
  ],
);

it('uses the same sealed-entity predicate for every CRUD operation, preserving global and tenant-wide rows', () => {
  const { policies } = getTableConfig(fixture);
  expect(policies.map((policy) => policy.for)).toEqual(['select', 'insert', 'update', 'delete']);
  for (const policy of policies) {
    const expressions = [policy.using, policy.withCheck].filter((expression) => expression !== undefined);
    expect(expressions.length).toBe(policy.for === 'update' ? 2 : 1);
    for (const expression of expressions) {
      const query = dialect.sqlToQuery(expression).sql;
      expect(query).toBe(
        '"gateway_scope_fixture"."tenant_id" = (select trust.current_tenant_id()) and ((select trust.current_legal_entity_id()) is null or "gateway_scope_fixture"."legal_entity_id" is null or "gateway_scope_fixture"."legal_entity_id" = (select trust.current_legal_entity_id()))',
      );
      expect(query).not.toContain('current_setting');
    }
  }
});
