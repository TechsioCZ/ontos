import { expect, it } from '@app/effect-rstest';
import { NodeServices } from '@effect/platform-node';
import { Crypto, Effect, FileSystem, Schema } from 'effect';
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

type MigrationColumn = (typeof tableColumns)[keyof typeof tableColumns][number];

const encodeJson = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));

const columnDefinitions = (columns: readonly MigrationColumn[]): string =>
  columns.map((column) => `"${column}" text`).join(', ');

const loadTableResult = (
  pool: Pool,
  quotedSchema: string,
  table: string,
  columns: readonly MigrationColumn[],
) =>
  Effect.tryPromise(() =>
    pool.query<MigrationFixtureRow>(`select * from ${quotedSchema}."${table}" order by record_id`),
  ).pipe(Effect.map((result) => ({ columns, result, table })));

const runSequentially = <Value, Result, Failure, Requirements>(
  values: readonly Value[],
  operation: (value: Value) => Effect.Effect<Result, Failure, Requirements>,
): Effect.Effect<void, Failure, Requirements> =>
  Effect.forEach(values, operation, { concurrency: 1, discard: true });

const contactsIdentityMigrationProgram = Effect.gen(function* contactsIdentityMigration() {
  const configuration = yield* loadDatabaseConnectionPair();
  const crypto = yield* Crypto.Crypto;
  const fileSystem = yield* FileSystem.FileSystem;
  const pool = yield* Effect.acquireRelease(
    Effect.sync(() => new Pool({ connectionString: configuration.admin.connectionString, max: 1 })),
    (resource) => Effect.tryPromise(() => resource.end()).pipe(Effect.orDie),
  );
  const schema = `core_contacts_identity_${(yield* crypto.randomUUIDv4).replaceAll('-', '')}`;
  const quotedSchema = `"${schema}"`;
  yield* Effect.gen(function* exerciseContactsIdentityMigration() {
    yield* Effect.tryPromise(() => pool.query(`create schema ${quotedSchema}`));
    yield* Effect.tryPromise(() =>
      pool.query(
        `create table ${quotedSchema}.tenant_module_states (
        record_id text primary key,
        tenant_id text not null,
        module_key text not null,
        payload jsonb not null,
        recorded_at timestamptz not null,
        unique (tenant_id, module_key)
      )`,
      ),
    );
    yield* runSequentially(Object.entries(tableColumns), ([table, columns]) =>
      Effect.tryPromise(() =>
        pool.query(
          `create table ${quotedSchema}."${table}" (
            record_id text primary key,
            ${columnDefinitions(columns)},
            payload jsonb not null default '{}'::jsonb
          )`,
        ),
      ),
    );
    const recordedAt = '2026-01-02T03:04:05.678Z';
    const payload = { freeText: 'crm.core must remain untouched inside arbitrary JSON' };
    const encodedPayload = encodeJson(payload);
    yield* Effect.tryPromise(() =>
      pool.query(
        `insert into ${quotedSchema}.tenant_module_states
        (record_id, tenant_id, module_key, payload, recorded_at)
       values ('legacy-state', 'tenant-a', $1, $2::jsonb, $3),
              ('unrelated-state', 'tenant-b', 'commerce.core', $2::jsonb, $3)`,
        [legacyModule, encodedPayload, recordedAt],
      ),
    );
    yield* runSequentially(Object.entries(tableColumns), ([table, columns]) => {
      const names = ['record_id', ...columns, 'payload'];
      const oldValues = [
        `${table}-legacy`,
        ...columns.map((_, index) => (index % 2 === 0 ? legacyModule : `${legacyModule}.record`)),
        encodedPayload,
      ];
      const unrelatedValues = [
        `${table}-unrelated`,
        ...columns.map(() => 'commerce.core.record'),
        encodedPayload,
      ];
      const placeholders = names.map((_, index) => `$${index + 1}`).join(', ');
      const quotedNames = names.map((name) => `"${name}"`).join(', ');
      const unrelatedPlaceholders = names
        .map((_, index) => `$${index + names.length + 1}`)
        .join(', ');
      return Effect.tryPromise(() =>
        pool.query(
          `insert into ${quotedSchema}."${table}" (${quotedNames})
           values (${placeholders}), (${unrelatedPlaceholders})`,
          [...oldValues, ...unrelatedValues],
        ),
      );
    });

    const migrationSource = yield* fileSystem.readFileString(
      new URL(
        '../../drizzle/20260901102632_rename-crm-module-identity/migration.sql',
        import.meta.url,
      ).pathname,
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
    yield* runSequentially([...statements, ...statements], (statement) =>
      Effect.tryPromise(() => pool.query(statement)),
    );

    const stateResult = yield* Effect.tryPromise(() =>
      pool.query<{
        module_key: string;
        payload: typeof payload;
        record_id: string;
        recorded_at: Date;
      }>(
        `select record_id, module_key, payload, recorded_at
         from ${quotedSchema}.tenant_module_states order by record_id`,
      ),
    );
    expect(
      stateResult.rows.map(({ module_key, record_id }) => ({ module_key, record_id })),
    ).toEqual([
      { module_key: contactsModule, record_id: 'legacy-state' },
      { module_key: 'commerce.core', record_id: 'unrelated-state' },
    ]);
    expect(stateResult.rows[0]?.payload).toEqual(payload);
    expect(stateResult.rows[0]?.recorded_at.toISOString()).toBe(recordedAt);
    const tableResults = yield* Effect.forEach(
      Object.entries(tableColumns),
      ([table, columns]) => loadTableResult(pool, quotedSchema, table, columns),
      { concurrency: 'unbounded' },
    );
    for (const { columns, result, table } of tableResults) {
      const [migrated, unrelated] = result.rows;
      expect(migrated).toBeDefined();
      if (migrated === undefined) {
        throw new Error('Expected migrated');
      }
      expect(unrelated).toBeDefined();
      if (unrelated === undefined) {
        throw new Error('Expected unrelated');
      }
      for (const column of columns) {
        expect(String(migrated[column]), `${table}.${column} was not migrated`).toMatch(
          /^contacts\.core(?:\.|$)/u,
        );
        expect(unrelated[column]).toBe('commerce.core.record');
      }
      expect(migrated.payload).toEqual(payload);
    }

    yield* Effect.tryPromise(() => pool.query(`truncate ${quotedSchema}.tenant_module_states`));
    yield* Effect.tryPromise(() =>
      pool.query(
        `insert into ${quotedSchema}.tenant_module_states
        (record_id, tenant_id, module_key, payload, recorded_at)
       values ('legacy-collision', 'tenant-c', $1, '{}'::jsonb, now()),
              ('contacts-collision', 'tenant-c', $2, '{}'::jsonb, now())`,
        [legacyModule, contactsModule],
      ),
    );
    const collisionError = yield* Effect.flip(
      Effect.tryPromise(() => pool.query(statements[0] ?? '')),
    );
    expect(String(collisionError.cause)).toMatch(/would collide/u);
    const collisionRows = yield* Effect.tryPromise(() =>
      pool.query<{ module_key: string }>(
        `select module_key from ${quotedSchema}.tenant_module_states order by module_key`,
      ),
    );
    expect(collisionRows.rows.map((row) => row.module_key)).toEqual([contactsModule, legacyModule]);
  }).pipe(
    Effect.ensuring(
      Effect.tryPromise(() => pool.query(`drop schema if exists ${quotedSchema} cascade`)).pipe(
        Effect.orDie,
      ),
    ),
  );
}).pipe(Effect.scoped);

it.layer(NodeServices.layer, { excludeTestServices: true })(
  'contacts-identity-migration',
  (suite) => {
    suite.effect(
      'Contacts Core identity migration is preserving, scoped, rerunnable, and collision-safe',
      () => contactsIdentityMigrationProgram,
    );
  },
);
