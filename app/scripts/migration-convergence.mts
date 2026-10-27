import { PgClient } from '@effect/sql-pg';
import { sql } from 'drizzle-orm';
import { makeWithDefaults } from 'drizzle-orm/effect-postgres';
import type { EffectPgDatabase } from 'drizzle-orm/effect-postgres';
import { readMigrationFiles } from 'drizzle-orm/migrator';
import type { MigrationMeta } from 'drizzle-orm/migrator';
import { migrate } from 'drizzle-orm/pg-core/effect/session';
import { Config, Crypto, Duration, Effect, FileSystem, Layer, Predicate, Schema } from 'effect';

import {
  MigrationEquivalenceError,
  MigrationLedgerRowSchema,
  planEquivalentMigrations,
} from './migration-equivalence.mts';
import type { MigrationHistory } from './migration-equivalence.mts';

/** Code-owned owner entrypoints supply these paths and pins, never runtime input. */
export interface MigrationConvergenceManifest {
  readonly folder: string;
  readonly history: MigrationHistory;
  readonly snapshots: readonly (readonly [name: string, sha256: string])[];
}

export interface ConvergentMigrationSource {
  readonly manifest: MigrationConvergenceManifest;
  readonly migrations: readonly MigrationMeta[];
}

/** Native Drizzle captures SQL in memory; historical snapshot bytes are independently pinned. */
export const loadConvergentMigrationSource = Effect.fn('MigrationConvergence.loadSource')(function* load(
  manifest: MigrationConvergenceManifest,
) {
  const { history } = manifest;
  const fs = yield* FileSystem.FileSystem;
  const crypto = yield* Crypto.Crypto;
  for (const [name, expected] of manifest.snapshots) {
    const bytes = yield* fs
      .readFile(`${manifest.folder}/${name}/snapshot.json`)
      .pipe(
        Effect.mapError(() => new MigrationEquivalenceError({ history, reason: 'Pinned snapshot is unavailable' })),
      );
    const digest = yield* crypto
      .digest('SHA-256', bytes)
      .pipe(Effect.mapError(() => new MigrationEquivalenceError({ history, reason: 'Snapshot hashing failed' })));
    const actual = Array.from(digest, (byte) => byte.toString(16).padStart(2, '0')).join('');
    if (actual !== expected) {
      return yield* new MigrationEquivalenceError({ history, reason: 'Pinned snapshot bytes changed' });
    }
  }
  const migrations = yield* Effect.try({
    catch: () => new MigrationEquivalenceError({ history, reason: 'Unable to read native migration history' }),
    try: () => readMigrationFiles({ migrationsFolder: manifest.folder }),
  });
  yield* planEquivalentMigrations(history, migrations, []);
  return { manifest, migrations } satisfies ConvergentMigrationSource;
});

const journal = (history: MigrationHistory) => `__drizzle_migrations_${history}`;
const qualifiedJournal = (history: MigrationHistory) =>
  sql`${sql.identifier('drizzle')}.${sql.identifier(journal(history))}`;

interface RawMigrationLedgerRow extends Readonly<Record<string, string | number | bigint | null>> {
  readonly created_at: string | number | bigint | null;
  readonly hash: string;
  readonly id: number | string;
  readonly name: string | null;
}

const readPlan = Effect.fn('MigrationConvergence.readPlan')(function* readMigrationPlan(
  database: EffectPgDatabase,
  source: ConvergentMigrationSource,
) {
  const { history } = source.manifest;
  const relation = `drizzle.${journal(history)}`;
  const exists = yield* database.execute<{ exists: boolean }>(
    sql`select to_regclass(${relation}) is not null as exists`,
    'objects',
  );
  const existence = yield* Schema.decodeUnknownEffect(Schema.Tuple([Schema.Struct({ exists: Schema.Boolean })]))(
    exists,
  ).pipe(Effect.mapError(() => new MigrationEquivalenceError({ history, reason: 'Journal existence is unknown' })));
  if (!existence[0].exists) {
    return yield* planEquivalentMigrations(history, source.migrations, []);
  }
  const columns = yield* database.execute<{ column_name: string }>(
    sql`select column_name from information_schema.columns
        where table_schema = 'drizzle' and table_name = ${journal(history)}`,
    'objects',
  );
  const columnNames = new Set(columns.map((row) => row.column_name));
  if (!['id', 'name', 'hash', 'created_at', 'applied_at'].every((name) => columnNames.has(name))) {
    return yield* new MigrationEquivalenceError({
      history,
      reason: 'Existing journal requires a separate version upgrade',
    });
  }
  yield* database.execute(sql`lock table ${qualifiedJournal(history)} in access exclusive mode`, 'objects');
  const rows = yield* database.execute<RawMigrationLedgerRow>(
    sql`select id, name, hash, created_at from ${qualifiedJournal(history)} order by id`,
    'objects',
  );
  const ledger = yield* Schema.decodeUnknownEffect(Schema.Array(MigrationLedgerRowSchema))(rows).pipe(
    Effect.mapError(() => new MigrationEquivalenceError({ history, reason: 'Applied journal rows are malformed' })),
  );
  return yield* planEquivalentMigrations(history, source.migrations, ledger);
});

/** Native Drizzle owns DDL, savepoints and real journal inserts; existing rows are never rewritten. */
export const convergeMigrationHistories = Effect.fn('MigrationConvergence.run')(function* converge(
  sources: readonly ConvergentMigrationSource[],
  preparation: Effect.Effect<void, MigrationEquivalenceError, PgClient.PgClient> = Effect.void,
) {
  const client = yield* PgClient.PgClient;
  const database = yield* makeWithDefaults();
  const [first] = sources;
  if (first === undefined || new Set(sources.map((source) => source.manifest.history)).size !== sources.length) {
    return yield* new MigrationEquivalenceError({
      history: 'core',
      reason: 'Owner migration histories are missing or repeated',
    });
  }
  return yield* client
    .withTransaction(
      Effect.gen(function* convergenceTransaction() {
        // Also serializes fresh journals, where LOCK TABLE cannot yet be used.
        yield* database.execute(
          sql`select pg_advisory_xact_lock(hashtext('ontos.exact-migration-equivalence'), 1)`,
          'objects',
        );
        yield* preparation;
        const plans = yield* Effect.forEach(
          sources,
          (source) => readPlan(database, source).pipe(Effect.map((plan) => ({ manifest: source.manifest, plan }))),
          { concurrency: 1 },
        );
        for (const { manifest, plan } of plans) {
          yield* migrate(plan.migrations, database._.session, {
            migrationsFolder: manifest.folder,
            migrationsSchema: 'drizzle',
            migrationsTable: journal(plan.history),
          });
        }
      }),
    )
    .pipe(
      Effect.mapError((error) =>
        Predicate.isTagged(error, 'MigrationEquivalenceError')
          ? error
          : new MigrationEquivalenceError({
              history: first.manifest.history,
              reason: 'Native migration convergence failed; transaction rolled back or outcome is unknown',
            }),
      ),
    );
});

/**
 * No dotenv files or owner runtime credentials are loaded.
 * Preserve server/role statement and lock budgets; the deployment runner owns the overall deadline.
 */
export const migrationDatabaseLayer = (history: MigrationHistory) =>
  Layer.effect(
    PgClient.PgClient,
    Effect.gen(function* migrationDatabase() {
      const url = yield* Config.schema(
        Schema.Redacted(Schema.Trim.pipe(Schema.check(Schema.isMinLength(1)))),
        'DATABASE_ADMIN_URL',
      );
      return yield* PgClient.makeClient({
        connectTimeout: Duration.seconds(30),
        url,
      }).pipe(
        Effect.mapError(
          () => new MigrationEquivalenceError({ history, reason: 'Migration database connection failed' }),
        ),
      );
    }),
  );
