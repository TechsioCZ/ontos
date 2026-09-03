import assert from 'node:assert/strict';
import test from 'node:test';
import { getTableConfig, PgDialect } from 'drizzle-orm/pg-core';
import {
  searchIndexEntries,
  searchProjectionGenerations,
  searchProjectionRebuilds,
} from '../../src/db/schema.ts';

const config = getTableConfig(searchIndexEntries);

test('Core Search rebuild floors are tenant/resource-scoped and cannot be deleted by runtime', () => {
  const rebuilds = getTableConfig(searchProjectionRebuilds);
  assert.equal(rebuilds.enableRLS, true);
  assert.deepEqual(
    rebuilds.primaryKeys[0]?.columns.map(({ name }) => name),
    ['tenant_id', 'source_module_key', 'source_resource_type'],
  );
  assert.deepEqual(
    rebuilds.policies.map(({ for: operation }) => operation),
    ['select', 'insert', 'update'],
  );
  assert.deepEqual(
    rebuilds.checks.map(({ name }) => name),
    [
      'core_search_projection_rebuilds_version_ck',
      'core_search_projection_rebuilds_fingerprint_ck',
    ],
  );
});

test('Core Search snapshot generations are independent tenant/source-scoped infrastructure', () => {
  const generations = getTableConfig(searchProjectionGenerations);
  assert.equal(generations.enableRLS, true);
  assert.deepEqual(
    generations.primaryKeys[0]?.columns.map(({ name }) => name),
    ['tenant_id', 'source_module_key'],
  );
  assert.deepEqual(
    generations.policies.map(({ for: operation }) => operation),
    ['select', 'insert', 'update'],
  );
  assert.ok(generations.columns.some(({ name }) => name === 'generation'));
  assert.ok(generations.columns.some(({ name }) => name === 'event_watermark'));
});

test('Core Search physical projection has versioned tenant-qualified lookup keys', () => {
  assert.equal(config.enableRLS, true);
  assert.deepEqual(
    config.columns
      .filter(({ name }) => ['deleted', 'projection_version'].includes(name))
      .map(({ name, notNull }) => ({ name, notNull })),
    [
      { name: 'deleted', notNull: true },
      { name: 'projection_version', notNull: true },
    ],
  );
  const source = config.indexes.find(
    ({ config: index }) => index.name === 'core_search_index_entries_source_uk',
  );
  assert.ok(source?.config.unique);
  assert.deepEqual(
    source.config.columns.map((column) => 'name' in column && column.name),
    ['tenant_id', 'source_module_key', 'source_resource_type', 'source_resource_id'],
  );
  const query = config.indexes.find(
    ({ config: index }) => index.name === 'core_search_index_entries_query_idx',
  );
  assert.ok(query);
  assert.deepEqual(
    query.config.columns.map((column) => 'name' in column && column.name),
    ['tenant_id', 'source_module_key', 'source_resource_type', 'legal_entity_id', 'deleted'],
  );
});

test('Core Search projection declares complete tenant RLS and bounded document checks', () => {
  assert.deepEqual(
    config.policies.map(({ name }) => name),
    [
      'core_search_index_entries_tenant_select',
      'core_search_index_entries_tenant_insert',
      'core_search_index_entries_tenant_update',
      'core_search_index_entries_tenant_delete',
    ],
  );
  assert.deepEqual(
    config.policies.map((policy) => policy.for),
    ['select', 'insert', 'update', 'delete'],
  );
  assert.equal(
    config.policies.every(({ to }) => to === 'ontos_runtime'),
    true,
  );
  const dialect = new PgDialect();
  const checks = config.checks.map(({ name, value }) => ({
    name,
    sql: dialect.sqlToQuery(value).sql,
  }));
  assert.match(
    checks.find(({ name }) => name === 'core_search_index_entries_document_ck')?.sql ?? '',
    /body_text/u,
  );
  assert.match(
    checks.find(({ name }) => name === 'core_search_index_entries_version_ck')?.sql ?? '',
    /projection_version/u,
  );
});
