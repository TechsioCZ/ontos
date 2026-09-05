/* eslint-disable no-await-in-loop -- DDL and migration statements must execute in deterministic sequence. */
// @effect-diagnostics asyncFunction:off nodeBuiltinImport:off
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { Effect, Redacted } from 'effect';
import { Pool } from 'pg';
import { loadDatabaseConnectionPair } from '../../src/db/config.ts';

const legacyModule = 'crm.core';
const contactsModule = 'contacts.core';

interface MigrationFixtureRow {
  readonly action_key?: string | null;
  readonly consumer_module_key?: string | null;
  readonly consumer_name?: string | null;
  readonly evidence_policy_key?: string | null;
  readonly module_key?: string | null;
  readonly payload: { readonly freeText: string };
  readonly producer_module_key?: string | null;
  readonly record_id: string;
  readonly retention_policy_key?: string | null;
  readonly serving_module_key?: string | null;
  readonly source_module_key?: string | null;
  readonly source_resource_type?: string | null;
  readonly stream_key?: string | null;
  readonly subject_module_key?: string | null;
  readonly subject_resource_type?: string | null;
  readonly target_module_key?: string | null;
  readonly target_resource_type?: string | null;
}

const tableColumns = {
  action_invocations: ['action_key', 'target_module_key', 'target_resource_type'],
  audit_events: ['target_module_key', 'target_resource_type'],
  data_access_events: [
    'serving_module_key',
    'target_module_key',
    'target_resource_type',
    'evidence_policy_key',
  ],
  domain_events: ['producer_module_key', 'subject_module_key', 'subject_resource_type'],
  evidence_references: [
    'subject_module_key',
    'subject_resource_type',
    'evidence_policy_key',
    'retention_policy_key',
  ],
  media_links: ['target_module_key', 'target_resource_type'],
  outbox_deliveries: ['consumer_module_key'],
  outbox_messages: ['producer_module_key'],
  search_index_entries: ['source_module_key', 'source_resource_type'],
  tenant_module_state_changes: ['module_key'],
  worker_checkpoints: ['consumer_name', 'stream_key'],
} as const;

test('Contacts Core identity migration is preserving, scoped, rerunnable, and collision-safe', async () => {
  const configuration = await Effect.runPromise(loadDatabaseConnectionPair());
  const pool = new Pool({
    connectionString: Redacted.value(configuration.admin.connectionString),
    max: 1,
  });
  const schema = `core_contacts_identity_${randomUUID().replaceAll('-', '')}`;
  const quotedSchema = `"${schema}"`;
  try {
    await pool.query(`create schema ${quotedSchema}`);
    await pool.query(
      `create table ${quotedSchema}.tenant_module_states (
        record_id text primary key,
        tenant_id text not null,
        module_key text not null,
        payload jsonb not null,
        recorded_at timestamptz not null,
        unique (tenant_id, module_key)
      )`,
    );
    for (const [table, columns] of Object.entries(tableColumns)) {
      await pool.query(
        `create table ${quotedSchema}."${table}" (
          record_id text primary key,
          ${columns.map((column) => `"${column}" text`).join(', ')},
          payload jsonb not null default '{}'::jsonb
        )`,
      );
    }
    const recordedAt = '2026-01-02T03:04:05.678Z';
    const payload = { freeText: 'crm.core must remain untouched inside arbitrary JSON' };
    await pool.query(
      `insert into ${quotedSchema}.tenant_module_states
        (record_id, tenant_id, module_key, payload, recorded_at)
       values ('legacy-state', 'tenant-a', $1, $2::jsonb, $3),
              ('unrelated-state', 'tenant-b', 'commerce.core', $2::jsonb, $3)`,
      [legacyModule, JSON.stringify(payload), recordedAt],
    );
    for (const [table, columns] of Object.entries(tableColumns)) {
      const names = ['record_id', ...columns, 'payload'];
      const oldValues = [
        `${table}-legacy`,
        ...columns.map((_, index) => (index % 2 === 0 ? legacyModule : `${legacyModule}.record`)),
        JSON.stringify(payload),
      ];
      const unrelatedValues = [
        `${table}-unrelated`,
        ...columns.map(() => 'commerce.core.record'),
        JSON.stringify(payload),
      ];
      const placeholders = names.map((_, index) => `$${index + 1}`).join(', ');
      const quotedNames = names.map((name) => `"${name}"`).join(', ');
      const unrelatedPlaceholders = names
        .map((_, index) => `$${index + names.length + 1}`)
        .join(', ');
      await pool.query(
        `insert into ${quotedSchema}."${table}" (${quotedNames})
         values (${placeholders}), (${unrelatedPlaceholders})`,
        [...oldValues, ...unrelatedValues],
      );
    }

    const migrationSource = await readFile(
      new URL(
        '../../drizzle/20260901102632_rename-crm-module-identity/migration.sql',
        import.meta.url,
      ),
      'utf-8',
    );
    const migrationTables = ['tenant_module_states', ...Object.keys(tableColumns)];
    let isolatedMigrationSource = migrationSource;
    for (const table of migrationTables) {
      isolatedMigrationSource = isolatedMigrationSource.replaceAll(
        `core.${table}`,
        `${quotedSchema}."${table}"`,
      );
    }
    const statements = isolatedMigrationSource
      .split('--> statement-breakpoint')
      .map((statement) => statement.trim())
      .filter((statement) => statement.length > 0);
    for (let run = 0; run < 2; run += 1) {
      for (const statement of statements) {
        await pool.query(statement);
      }
    }

    const stateResult = await pool.query<{
      module_key: string;
      payload: typeof payload;
      record_id: string;
      recorded_at: Date;
    }>(
      `select record_id, module_key, payload, recorded_at
       from ${quotedSchema}.tenant_module_states order by record_id`,
    );
    assert.deepEqual(
      stateResult.rows.map(({ module_key, record_id }) => ({ module_key, record_id })),
      [
        { module_key: contactsModule, record_id: 'legacy-state' },
        { module_key: 'commerce.core', record_id: 'unrelated-state' },
      ],
    );
    assert.deepEqual(stateResult.rows[0]?.payload, payload);
    assert.equal(stateResult.rows[0]?.recorded_at.toISOString(), recordedAt);
    for (const [table, columns] of Object.entries(tableColumns)) {
      const result = await pool.query<MigrationFixtureRow>(
        `select * from ${quotedSchema}."${table}" order by record_id`,
      );
      const [migrated, unrelated] = result.rows;
      assert.ok(migrated);
      assert.ok(unrelated);
      for (const column of columns) {
        assert.match(
          String(migrated[column]),
          /^contacts\.core(?:\.|$)/u,
          `${table}.${column} was not migrated`,
        );
        assert.equal(unrelated[column], 'commerce.core.record');
      }
      assert.deepEqual(migrated.payload, payload);
    }

    await pool.query(`truncate ${quotedSchema}.tenant_module_states`);
    await pool.query(
      `insert into ${quotedSchema}.tenant_module_states
        (record_id, tenant_id, module_key, payload, recorded_at)
       values ('legacy-collision', 'tenant-c', $1, '{}'::jsonb, now()),
              ('contacts-collision', 'tenant-c', $2, '{}'::jsonb, now())`,
      [legacyModule, contactsModule],
    );
    await assert.rejects(async () => await pool.query(statements[0] ?? ''), /would collide/u);
    const collisionRows = await pool.query<{ module_key: string }>(
      `select module_key from ${quotedSchema}.tenant_module_states order by module_key`,
    );
    assert.deepEqual(
      collisionRows.rows.map((row) => row.module_key),
      [contactsModule, legacyModule],
    );
  } finally {
    await pool.query(`drop schema if exists ${quotedSchema} cascade`);
    await pool.end();
  }
});
