import { expect, it } from '@app/effect-rstest';
import { getTableConfig, PgDialect } from 'drizzle-orm/pg-core';
import {
  searchIndexEntries,
  searchProjectionGenerations,
  searchProjectionRebuilds,
} from '../../src/db/schema.ts';

const config = getTableConfig(searchIndexEntries);

it('Core Search rebuild floors are tenant/resource-scoped and cannot be deleted by runtime', () => {
  const rebuilds = getTableConfig(searchProjectionRebuilds);
  expect(rebuilds.enableRLS).toBe(true);
  expect(rebuilds.primaryKeys[0]?.columns.map(({ name }) => name)).toEqual([
    'tenant_id',
    'source_module_key',
    'source_resource_type',
  ]);
  expect(rebuilds.policies.map(({ for: operation }) => operation)).toEqual([
    'select',
    'insert',
    'update',
  ]);
  expect(rebuilds.checks.map(({ name }) => name)).toEqual([
    'core_search_projection_rebuilds_version_ck',
    'core_search_projection_rebuilds_fingerprint_ck',
  ]);
});

it('Core Search snapshot generations are independent tenant/source-scoped infrastructure', () => {
  const generations = getTableConfig(searchProjectionGenerations);
  expect(generations.enableRLS).toBe(true);
  expect(generations.primaryKeys[0]?.columns.map(({ name }) => name)).toEqual([
    'tenant_id',
    'source_module_key',
  ]);
  expect(generations.policies.map(({ for: operation }) => operation)).toEqual([
    'select',
    'insert',
    'update',
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
  const source = config.indexes.find(
    ({ config: index }) => index.name === 'core_search_index_entries_source_uk',
  );
  expect(source?.config.unique).toBe(true);
  expect(source?.config.columns.map((column) => 'name' in column && column.name)).toEqual([
    'tenant_id',
    'source_module_key',
    'source_resource_type',
    'source_resource_id',
  ]);
  const query = config.indexes.find(
    ({ config: index }) => index.name === 'core_search_index_entries_query_idx',
  );
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
  expect(config.policies.map(({ name }) => name)).toEqual([
    'core_search_index_entries_tenant_select',
    'core_search_index_entries_tenant_insert',
    'core_search_index_entries_tenant_update',
    'core_search_index_entries_tenant_delete',
  ]);
  expect(config.policies.map((policy) => policy.for)).toEqual([
    'select',
    'insert',
    'update',
    'delete',
  ]);
  expect(config.policies.every(({ to }) => to === 'ontos_runtime')).toBe(true);
  const dialect = new PgDialect();
  const checks = config.checks.map(({ name, value }) => ({
    name,
    sql: dialect.sqlToQuery(value).sql,
  }));
  expect(
    checks.find(({ name }) => name === 'core_search_index_entries_document_ck')?.sql ?? '',
  ).toMatch(/body_text/u);
  expect(
    checks.find(({ name }) => name === 'core_search_index_entries_version_ck')?.sql ?? '',
  ).toMatch(/projection_version/u);
});
