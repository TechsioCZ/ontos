import { getTableConfig, PgDialect } from 'drizzle-orm/pg-core';
import { expect, it } from 'effect-rstest';

import { searchIndexEntries, searchProjectionGenerations, searchProjectionRebuilds } from '../../src/db/schema.ts';

const config = getTableConfig(searchIndexEntries);

it('Core Search rebuild floors are tenant/resource-scoped and cannot be deleted by runtime', () => {
  const rebuilds = getTableConfig(searchProjectionRebuilds);
  expect(rebuilds.enableRLS).toBe(true);
  expect(rebuilds.primaryKeys[0]?.columns.map(({ name }) => name)).toEqual([
    'tenant_id',
    'source_module_key',
    'source_resource_type',
  ]);
  expect(rebuilds.policies.map(({ for: operation, name, to }) => ({ name, operation, to }))).toEqual([
    { name: 'core_search_projection_rebuilds_tenant_select', operation: 'select', to: 'ontos_runtime' },
    { name: 'core_search_projection_rebuilds_tenant_insert', operation: 'insert', to: 'ontos_runtime' },
    { name: 'core_search_projection_rebuilds_tenant_update', operation: 'update', to: 'ontos_runtime' },
    {
      name: 'core_search_projection_rebuilds_party_registry_worker_select',
      operation: 'select',
      to: 'party_registry_worker',
    },
    {
      name: 'core_search_projection_rebuilds_party_registry_worker_insert',
      operation: 'insert',
      to: 'party_registry_worker',
    },
    {
      name: 'core_search_projection_rebuilds_party_registry_worker_update',
      operation: 'update',
      to: 'party_registry_worker',
    },
  ]);
  expect(rebuilds.checks.map(({ name }) => name)).toEqual([
    'core_search_projection_rebuilds_version_ck',
    'core_search_projection_rebuilds_fingerprint_ck',
  ]);
});

it('Core Search snapshot generations are independent tenant/source-scoped infrastructure', () => {
  const generations = getTableConfig(searchProjectionGenerations);
  expect(generations.enableRLS).toBe(true);
  expect(generations.primaryKeys[0]?.columns.map(({ name }) => name)).toEqual(['tenant_id', 'source_module_key']);
  expect(generations.policies.map(({ for: operation, name, to }) => ({ name, operation, to }))).toEqual([
    { name: 'core_search_projection_generations_tenant_select', operation: 'select', to: 'ontos_runtime' },
    { name: 'core_search_projection_generations_tenant_insert', operation: 'insert', to: 'ontos_runtime' },
    { name: 'core_search_projection_generations_tenant_update', operation: 'update', to: 'ontos_runtime' },
    {
      name: 'core_search_projection_generations_party_registry_worker_select',
      operation: 'select',
      to: 'party_registry_worker',
    },
    {
      name: 'core_search_projection_generations_party_registry_worker_insert',
      operation: 'insert',
      to: 'party_registry_worker',
    },
    {
      name: 'core_search_projection_generations_party_registry_worker_update',
      operation: 'update',
      to: 'party_registry_worker',
    },
  ]);
  expect(generations.columns.some(({ name }) => name === 'generation')).toBe(true);
  expect(generations.columns.some(({ name }) => name === 'event_watermark')).toBe(true);
});

it('Core Search physical projection has versioned tenant-qualified lookup keys', () => {
  expect(config.enableRLS).toBe(true);
  expect(
    config.columns
      .filter(({ name }) => ['deleted', 'projection_version'].includes(name))
      .map(({ name, notNull }) => ({ name, notNull })),
  ).toEqual([
    { name: 'deleted', notNull: true },
    { name: 'projection_version', notNull: true },
  ]);
  const source = config.indexes.find(({ config: index }) => index.name === 'core_search_index_entries_source_uk');
  expect(source?.config.unique).toBe(true);
  expect(source?.config.columns.map((column) => 'name' in column && column.name)).toEqual([
    'tenant_id',
    'source_module_key',
    'source_resource_type',
    'source_resource_id',
  ]);
  const query = config.indexes.find(({ config: index }) => index.name === 'core_search_index_entries_query_idx');
  expect(query).toBeDefined();
  expect(query?.config.columns.map((column) => 'name' in column && column.name)).toEqual([
    'tenant_id',
    'source_module_key',
    'source_resource_type',
    'legal_entity_id',
    'deleted',
  ]);
});

it('Core Search projection declares complete tenant RLS and bounded document checks', () => {
  expect(config.policies.map(({ for: command, name, to }) => ({ command, name, to }))).toEqual([
    { command: 'select', name: 'core_search_index_entries_tenant_select', to: 'ontos_runtime' },
    { command: 'insert', name: 'core_search_index_entries_tenant_insert', to: 'ontos_runtime' },
    { command: 'update', name: 'core_search_index_entries_tenant_update', to: 'ontos_runtime' },
    { command: 'delete', name: 'core_search_index_entries_tenant_delete', to: 'ontos_runtime' },
    {
      command: 'select',
      name: 'core_search_index_entries_party_registry_request_select',
      to: 'party_registry_runtime',
    },
    { command: 'select', name: 'core_search_index_entries_party_registry_worker_select', to: 'party_registry_worker' },
    { command: 'insert', name: 'core_search_index_entries_party_registry_worker_insert', to: 'party_registry_worker' },
    { command: 'update', name: 'core_search_index_entries_party_registry_worker_update', to: 'party_registry_worker' },
  ]);
  const dialect = new PgDialect();
  const policySql = new Map(
    config.policies.map(({ name, using, withCheck }) => [
      name,
      [using, withCheck].flatMap((value) => (value === undefined ? [] : [dialect.sqlToQuery(value).sql])),
    ]),
  );
  for (const [name, predicates] of policySql) {
    for (const predicate of predicates) {
      if (name.includes('_tenant_')) {
        expect(predicate).toContain("<> 'party.registry'");
      } else {
        expect(predicate).toContain("= 'party.registry'");
      }
      if (name.includes('_party_registry_request_')) {
        expect(predicate).toContain('(select trust.current_tenant_id())');
        expect(predicate).not.toContain('current_setting');
      }
    }
  }
  const checks = config.checks.map(({ name, value }) => ({
    name,
    sql: dialect.sqlToQuery(value).sql,
  }));
  expect(checks.find(({ name }) => name === 'core_search_index_entries_document_ck')?.sql ?? '').toMatch(/body_text/u);
  expect(checks.find(({ name }) => name === 'core_search_index_entries_version_ck')?.sql ?? '').toMatch(
    /projection_version/u,
  );
});
