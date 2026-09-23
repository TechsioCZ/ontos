import { expect, it } from 'effect-rstest';
import { getTableConfig } from 'drizzle-orm/pg-core';
import { Array as EffectArray, Order } from 'effect';

import {
  PRICE_GROUP_CATALOG_SCHEMA_NAME,
  PRICE_GROUP_CATALOG_TABLE_INVENTORY,
  PRICE_GROUP_CATALOG_TABLES,
  priceGroupCatalogLedger,
  priceGroupCompatibilitySupport,
  priceGroupContainmentProjectionIntents,
  priceGroupDefinitionEffectiveIntervals,
  priceGroupDefinitionRevisions,
  priceGroupRetirements,
  priceGroups,
} from '../../src/database/schema.ts';

it('owns the exact tenant-scoped Price Group Catalog schema', () => {
  const qualifiedNames = EffectArray.sort(
    PRICE_GROUP_CATALOG_TABLES.map((table) => {
      const config = getTableConfig(table);
      return `${config.schema}.${config.name}`;
    }),
    Order.String,
  );

  expect(PRICE_GROUP_CATALOG_SCHEMA_NAME).toBe('price_group_catalog');
  expect(PRICE_GROUP_CATALOG_TABLE_INVENTORY).toEqual([
    'price_group_catalog_ledger',
    'price_group_compatibility_support',
    'price_group_containment_projection_intents',
    'price_group_definition_effective_intervals',
    'price_group_definition_revisions',
    'price_group_retirements',
    'price_groups',
  ]);
  expect(qualifiedNames).toEqual(
    PRICE_GROUP_CATALOG_TABLE_INVENTORY.map((tableName) => `price_group_catalog.${tableName}`),
  );
});

it('owns durable tenant-only containment projection intent evidence', () => {
  const intents = getTableConfig(priceGroupContainmentProjectionIntents);

  expect(intents.uniqueConstraints.map((constraint) => constraint.name)).toEqual(
    expect.arrayContaining([
      'price_group_catalog_containment_intents_scope_mutation_uk',
      'price_group_catalog_containment_intents_scope_action_uk',
      'price_group_catalog_containment_intents_scope_group_uk',
    ]),
  );
  expect(intents.foreignKeys.map((foreignKey) => foreignKey.getName())).toEqual(
    expect.arrayContaining([
      'price_group_catalog_containment_intents_definition_fk',
      'price_group_catalog_containment_intents_ledger_fk',
    ]),
  );
  expect(intents.checks.map((constraint) => constraint.name)).toEqual(
    expect.arrayContaining([
      'price_group_catalog_containment_intents_operation_ck',
      'price_group_catalog_containment_intents_catalog_version_ck',
      'price_group_catalog_containment_intents_state_ck',
      'price_group_catalog_containment_intents_completion_ck',
    ]),
  );
  expect(intents.indexes.map((definitionIndex) => definitionIndex.config.name)).toContain(
    'price_group_catalog_containment_intents_pending_idx',
  );
});

it('forces every owner table through tenant-only RLS', () => {
  for (const table of PRICE_GROUP_CATALOG_TABLES) {
    const config = getTableConfig(table);
    expect(config.enableRLS, `${config.name} must enable RLS`).toBe(true);
    expect(config.columns.some((column) => column.name === 'tenant_id' && column.notNull)).toBe(true);
    expect(config.columns.some((column) => column.name === 'legal_entity_id')).toBe(false);
    expect(config.policies.map((policy) => policy.for)).toEqual(['select', 'insert', 'update', 'delete']);
    for (const policy of config.policies) {
      expect(policy.to).toBe('ontos_runtime');
    }
  }
});

it('makes tenant-local code and stable classification meaning database invariants', () => {
  const groups = getTableConfig(priceGroups);
  const groupUniqueNames = groups.uniqueConstraints.map((constraint) => constraint.name);

  expect(groupUniqueNames).toContain('price_group_catalog_groups_scope_code_uk');
  expect(groupUniqueNames).toContain('price_group_catalog_groups_scope_meaning_uk');
  expect(groups.checks.map((constraint) => constraint.name)).toContain('price_group_catalog_groups_retirement_ck');
  expect(groups.foreignKeys.map((foreignKey) => foreignKey.getName())).toContain(
    'price_group_catalog_groups_creation_ledger_fk',
  );
});

it('stores immutable definitions separately from catalog-fenced effective schedules', () => {
  const definitions = getTableConfig(priceGroupDefinitionRevisions);
  const intervals = getTableConfig(priceGroupDefinitionEffectiveIntervals);

  expect(definitions.uniqueConstraints.map((constraint) => constraint.name)).toEqual(
    expect.arrayContaining([
      'price_group_catalog_definitions_invocation_uk',
      'price_group_catalog_definitions_number_uk',
      'price_group_catalog_definitions_scope_id_uk',
    ]),
  );
  expect(definitions.checks.map((constraint) => constraint.name)).toEqual(
    expect.arrayContaining([
      'price_group_catalog_definitions_predecessor_ck',
      'price_group_catalog_definitions_revision_ck',
    ]),
  );
  expect(definitions.foreignKeys.map((foreignKey) => foreignKey.getName())).toContain(
    'price_group_catalog_definitions_stable_meaning_fk',
  );
  expect(intervals.uniqueConstraints.map((constraint) => constraint.name)).toEqual(
    expect.arrayContaining([
      'price_group_catalog_intervals_effective_start_uk',
      'price_group_catalog_intervals_revision_uk',
      'price_group_catalog_intervals_scope_id_uk',
    ]),
  );
  expect(intervals.checks.map((constraint) => constraint.name)).toContain('price_group_catalog_intervals_period_ck');
  expect(intervals.indexes.map((definitionIndex) => definitionIndex.config.name)).toContain(
    'price_group_catalog_intervals_current_lookup_idx',
  );
  expect(getTableConfig(priceGroups).columns.map((column) => column.name)).toContain(
    'current_definition_schedule_revision',
  );
});

it('ties exact compatibility support and terminal retirement to revision and catalog evidence', () => {
  const ledger = getTableConfig(priceGroupCatalogLedger);
  const compatibility = getTableConfig(priceGroupCompatibilitySupport);
  const retirements = getTableConfig(priceGroupRetirements);

  expect(ledger.uniqueConstraints.map((constraint) => constraint.name)).toEqual(
    expect.arrayContaining([
      'price_group_catalog_ledger_scope_invocation_uk',
      'price_group_catalog_ledger_scope_revision_uk',
    ]),
  );
  expect(compatibility.uniqueConstraints.map((constraint) => constraint.name)).toContain(
    'price_group_catalog_compatibility_exact_contract_uk',
  );
  expect(compatibility.foreignKeys.map((foreignKey) => foreignKey.getName())).toContain(
    'price_group_catalog_compatibility_definition_fk',
  );
  expect(retirements.uniqueConstraints.map((constraint) => constraint.name)).toContain(
    'price_group_catalog_retirements_group_uk',
  );
  expect(retirements.foreignKeys.map((foreignKey) => foreignKey.getName())).toEqual(
    expect.arrayContaining([
      'price_group_catalog_retirements_definition_fk',
      'price_group_catalog_retirements_expected_ledger_fk',
      'price_group_catalog_retirements_group_fk',
      'price_group_catalog_retirements_ledger_fk',
    ]),
  );
});
