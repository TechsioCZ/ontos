import { NodeCrypto, NodeFileSystem } from '@effect/platform-node';
import type { MigrationMeta } from 'drizzle-orm/migrator';
import { Effect, FileSystem, Layer, Predicate, Schema } from 'effect';
import { Reactivity } from 'effect/reactivity';
import { SqlError, UnknownError } from 'effect/sql/SqlError';
import { assert, expect, it } from 'effect-rstest';

import { CORE_MIGRATION_MANIFEST } from '../../packages/core-runtime/scripts/migration-equivalence.mts';
import { scriptedPgClientLayer } from '../../packages/core-runtime/src/testing/scripted-pg-client.ts';
import { testSqlConnection } from '../../packages/core-runtime/tests/support/sql-connection.ts';
import { PARTY_MIGRATION_MANIFESTS } from '../../verticals/party-registry/scripts/migration-equivalence.mts';
import { convergeMigrationHistories, loadConvergentMigrationSource } from '../migration-convergence.mts';
import type { ConvergentMigrationSource } from '../migration-convergence.mts';
import { MIGRATION_EQUIVALENCES, MIGRATION_MERGES, planEquivalentMigrations } from '../migration-equivalence.mts';
import type { MigrationHistory, MigrationLedgerRow } from '../migration-equivalence.mts';

const manifests = [CORE_MIGRATION_MANIFEST, ...PARTY_MIGRATION_MANIFESTS];
const loadSources = Effect.forEach(manifests, (manifest) => loadConvergentMigrationSource(manifest), {
  concurrency: 1,
});

const rowFor = (migration: MigrationMeta, index: number): MigrationLedgerRow => ({
  created_at: String(migration.folderMillis),
  hash: migration.hash,
  id: index + 1,
  name: migration.name,
});

const appliedRows = (source: ConvergentMigrationSource, lineage: 'main' | 'demo') => {
  const pairs = MIGRATION_EQUIVALENCES.filter((pair) => pair.history === source.manifest.history);
  const omitted = new Set<string>(pairs.map((pair) => (lineage === 'main' ? pair.demo : pair.main)));
  return source.migrations
    .filter((migration) => !omitted.has(migration.name) && migration.name !== MIGRATION_MERGES[source.manifest.history])
    .map(rowFor);
};

const MigrationRowInputSchema = Schema.Struct({
  created_at: Schema.Union([Schema.Number, Schema.String]),
  hash: Schema.String,
  name: Schema.String,
});

const journalInsert = 'insert into';

interface JournalFixture {
  readonly history: MigrationHistory;
  readonly rows: MigrationLedgerRow[];
}

const historyIn = (text: string) =>
  manifests.find((manifest) => text.includes(`__drizzle_migrations_${manifest.history}`))?.history;

interface FixtureOptions {
  readonly failDdl?: boolean;
  readonly legacyColumns?: boolean;
  readonly unknownExistence?: boolean;
}

const metadataReply = (
  text: string,
  params: readonly unknown[],
  ledger: ReadonlyMap<MigrationHistory, MigrationLedgerRow[]>,
  options: FixtureOptions,
): readonly object[] | undefined => {
  if (text.includes('to_regclass')) {
    if (options.unknownExistence === true) {
      return [];
    }
    const history = historyIn(String(params[0]));
    return [{ exists: history !== undefined && ledger.has(history) }];
  }
  if (text.includes('FROM information_schema.tables')) {
    const history = historyIn(String(params[1]));
    return history !== undefined && ledger.has(history) ? [{ exists: 1 }] : [];
  }
  if (text.includes('information_schema.columns') || text.includes('pg_catalog.pg_attribute')) {
    const names =
      options.legacyColumns === true
        ? ['id', 'hash', 'created_at']
        : ['id', 'hash', 'created_at', 'name', 'applied_at'];
    return names.map((name) => ({ column_name: name }));
  }
  return undefined;
};

/** Scripts the wire only. Native Drizzle and Effect own all migration and transaction decisions. */
const nativeFixture = (journals: readonly JournalFixture[], options: FixtureOptions = {}) => {
  const ledger = new Map(journals.map(({ history, rows }) => [history, [...rows]]));
  const events: { readonly params: readonly unknown[]; readonly text: string }[] = [];
  let transactionStart: Map<MigrationHistory, MigrationLedgerRow[]> | undefined;
  const execute = (text: string, params: readonly unknown[]) =>
    Effect.suspend<readonly object[], SqlError, never>(() => {
      events.push({ params, text });
      if (text === 'BEGIN') {
        transactionStart = new Map([...ledger].map(([history, rows]) => [history, [...rows]]));
      }
      if (text === 'ROLLBACK' && transactionStart !== undefined) {
        ledger.clear();
        for (const [history, rows] of transactionStart) {
          ledger.set(history, [...rows]);
        }
      }
      const metadata = metadataReply(text, params, ledger, options);
      if (metadata !== undefined) {
        return Effect.succeed(metadata);
      }
      const history = historyIn(text);
      if (text.includes('CREATE TABLE IF NOT EXISTS') && history !== undefined) {
        ledger.set(history, ledger.get(history) ?? []);
      }
      if (/select id, (?:name, hash|hash, created_at)/u.test(text) && history !== undefined) {
        return Effect.succeed(ledger.get(history) ?? []);
      }
      if (text.includes(journalInsert) && history !== undefined) {
        const rows = ledger.get(history);
        if (rows === undefined) {
          return Effect.die('Missing scripted native journal');
        }
        const row = Schema.decodeUnknownSync(MigrationRowInputSchema)({
          created_at: params[1],
          hash: params[0],
          name: params[2],
        });
        rows.push({ ...row, id: rows.length + 1 });
      }
      if (options.failDdl === true && text.includes('CREATE SCHEMA IF NOT EXISTS')) {
        return Effect.fail(new SqlError({ reason: new UnknownError({ cause: 'Scripted native DDL failure' }) }));
      }
      return Effect.succeed([]);
    });
  const layer = scriptedPgClientLayer(Effect.succeed(testSqlConnection(execute))).pipe(Layer.provide(Reactivity.layer));
  return { events, layer, ledger };
};

it.layer(Layer.mergeAll(NodeFileSystem.layer, NodeCrypto.layer))((suite) => {
  suite.effect('pins the six exact equivalences and every retained historical snapshot', () =>
    Effect.gen(function* sourcePins() {
      const sources = yield* loadSources;
      expect(MIGRATION_EQUIVALENCES).toHaveLength(6);
      expect(sources.map(({ manifest }) => manifest.history)).toEqual(['core', 'contacts', 'party']);
      for (const source of sources) {
        const plan = yield* planEquivalentMigrations(source.manifest.history, source.migrations, []);
        expect(plan.lineage).toBe('main');
        const omitted = MIGRATION_EQUIVALENCES.filter((pair) => pair.history === source.manifest.history);
        expect(plan.migrations.map(({ name }) => name)).toEqual(
          source.migrations.filter(({ name }) => !omitted.some((pair) => pair.demo === name)).map(({ name }) => name),
        );
      }
    }),
  );

  for (const lineage of ['main', 'demo'] as const) {
    suite.effect(
      `${lineage} ledger selects the original identities and retains every unique Core recovery migration`,
      () =>
        Effect.gen(function* originalIdentity() {
          for (const source of yield* loadSources) {
            const rows = appliedRows(source, lineage);
            const before = rows.map((row) => ({ ...row }));
            const plan = yield* planEquivalentMigrations(source.manifest.history, source.migrations, rows);
            expect(plan.lineage).toBe(lineage);
            expect(plan.migrations.map(({ name }) => name)).toEqual([
              ...rows.map(({ name }) => name),
              MIGRATION_MERGES[source.manifest.history],
            ]);
            expect(rows).toEqual(before);
          }
        }),
    );

    suite.effect(
      `native migration on ${lineage} journals adds only real checkpoints, preserves old rows and reruns without inserts`,
      () =>
        Effect.gen(function* nativePopulatedRerun() {
          const sources = yield* loadSources;
          const journals = sources.map((source) => ({
            history: source.manifest.history,
            rows: appliedRows(source, lineage),
          }));
          const fixture = nativeFixture(journals);
          yield* convergeMigrationHistories(sources).pipe(Effect.provide(fixture.layer));
          for (const journal of journals) {
            const actual = fixture.ledger.get(journal.history) ?? [];
            expect(actual.slice(0, journal.rows.length)).toEqual(journal.rows);
            expect(actual.slice(journal.rows.length).map(({ name }) => name)).toEqual([
              MIGRATION_MERGES[journal.history],
            ]);
          }
          const insertsBefore = fixture.events.filter(({ text }) => text.includes(journalInsert)).length;
          yield* convergeMigrationHistories(sources).pipe(Effect.provide(fixture.layer));
          expect(fixture.events.filter(({ text }) => text.includes(journalInsert))).toHaveLength(insertsBefore);
          expect(fixture.events.some(({ text }) => /^UPDATE|^DELETE|^ALTER TABLE/iu.test(text.trim()))).toBe(false);
          expect(fixture.events.some(({ text }) => text.includes('pg_advisory_xact_lock'))).toBe(true);
          expect(fixture.events.some(({ text }) => text.includes('access exclusive mode'))).toBe(true);
          expect(fixture.events.at(-1)?.text).toBe('COMMIT');
        }),
    );
  }

  suite.effect('fresh native migration executes only canonical identities and keeps all other migrations', () =>
    Effect.gen(function* nativeFresh() {
      const sources = yield* loadSources;
      const fixture = nativeFixture([]);
      yield* convergeMigrationHistories(sources).pipe(Effect.provide(fixture.layer));
      for (const source of sources) {
        const plan = yield* planEquivalentMigrations(source.manifest.history, source.migrations, []);
        expect(fixture.ledger.get(source.manifest.history)?.map(({ name }) => name)).toEqual(
          plan.migrations.map(({ name }) => name),
        );
      }
      expect(fixture.events.at(-1)?.text).toBe('COMMIT');
    }),
  );

  suite.effect('unrecognized source hash, missing pair, duplicate name or changed checkpoint fails closed', () =>
    Effect.gen(function* invalidSources() {
      for (const source of yield* loadSources) {
        const pair = MIGRATION_EQUIVALENCES.find((item) => item.history === source.manifest.history);
        assert.isOk(pair !== undefined);
        const badCases = [
          source.migrations.map((migration) =>
            migration.name === pair.main ? { ...migration, hash: '0'.repeat(64) } : migration,
          ),
          source.migrations.filter((migration) => migration.name !== pair.demo),
          [...source.migrations, ...source.migrations.slice(0, 1)],
          source.migrations.map((migration) =>
            migration.name === MIGRATION_MERGES[source.manifest.history]
              ? { ...migration, sql: ['select 2;'] }
              : migration,
          ),
        ];
        for (const migrations of badCases) {
          const failure = yield* planEquivalentMigrations(source.manifest.history, migrations, []).pipe(Effect.flip);
          expect(Predicate.isTagged(failure, 'MigrationEquivalenceError')).toBe(true);
        }
      }
    }),
  );

  suite.effect('applied bad hash, timestamp, unknown identity, repeated row, or both lineages prevents all DDL', () =>
    Effect.gen(function* invalidLedgers() {
      const sources = yield* loadSources;
      for (const source of sources) {
        const valid = appliedRows(source, 'demo');
        const [first] = valid;
        assert.isOk(first !== undefined);
        const mainPair = MIGRATION_EQUIVALENCES.find((pair) => pair.history === source.manifest.history);
        const other = source.migrations.find((migration) => migration.name === mainPair?.main);
        assert.isOk(other !== undefined);
        const invalidCases = [
          [{ ...first, hash: 'f'.repeat(64) }, ...valid.slice(1)],
          [{ ...first, created_at: '0' }, ...valid.slice(1)],
          [{ ...first, name: 'unknown-migration' }, ...valid.slice(1)],
          [...valid, first],
          [...valid, rowFor(other, valid.length)],
        ];
        for (const rows of invalidCases) {
          const fixture = nativeFixture(
            sources.map((item) => ({
              history: item.manifest.history,
              rows: item === source ? rows : appliedRows(item, 'demo'),
            })),
          );
          yield* convergeMigrationHistories(sources).pipe(Effect.provide(fixture.layer), Effect.flip);
          expect(
            fixture.events.some(({ text }) => text.includes('CREATE SCHEMA') || text.includes(journalInsert)),
          ).toBe(false);
          expect(fixture.events.at(-1)?.text).toBe('ROLLBACK');
        }
      }
    }),
  );

  suite.effect('legacy journal shape and unknown existence never authorize native migration', () =>
    Effect.gen(function* unknownJournal() {
      const sources = yield* loadSources;
      for (const options of [{ legacyColumns: true }, { unknownExistence: true }]) {
        const fixture = nativeFixture(
          sources.map((source) => ({ history: source.manifest.history, rows: appliedRows(source, 'main') })),
          options,
        );
        yield* convergeMigrationHistories(sources).pipe(Effect.provide(fixture.layer), Effect.flip);
        expect(fixture.events.some(({ text }) => text.includes('CREATE SCHEMA'))).toBe(false);
        expect(fixture.events.at(-1)?.text).toBe('ROLLBACK');
      }
    }),
  );

  suite.effect('incomplete or mixed predecessor evidence and an unsupported checkpoint fail closed', () =>
    Effect.gen(function* predecessorEvidence() {
      for (const source of yield* loadSources) {
        const pairs = MIGRATION_EQUIVALENCES.filter((pair) => pair.history === source.manifest.history);
        const checkpoint = source.migrations.find(
          (migration) => migration.name === MIGRATION_MERGES[source.manifest.history],
        );
        assert.isOk(checkpoint !== undefined);
        yield* planEquivalentMigrations(source.manifest.history, source.migrations, [rowFor(checkpoint, 0)]).pipe(
          Effect.flip,
        );
        if (pairs.length > 1) {
          const [first, second] = pairs;
          assert.isOk(first !== undefined && second !== undefined);
          const initial = source.migrations.find((migration) => migration.name === first.main);
          const later = source.migrations.find((migration) => migration.name === second.demo);
          assert.isOk(initial !== undefined && later !== undefined);
          for (const rows of [[rowFor(later, 0)], [rowFor(initial, 0), rowFor(later, 1)]]) {
            yield* planEquivalentMigrations(source.manifest.history, source.migrations, rows).pipe(Effect.flip);
          }
        }
      }
    }),
  );

  suite.effect('a matching hash outside the exact allowlist is never silently deduplicated', () =>
    Effect.gen(function* notGeneralHashDeduplication() {
      for (const source of yield* loadSources) {
        const [first] = source.migrations;
        assert.isOk(first !== undefined);
        const unrelated = { ...first, name: '20261027235959_unrelated-migration' };
        const plan = yield* planEquivalentMigrations(source.manifest.history, [...source.migrations, unrelated], []);
        expect(plan.migrations.map(({ name }) => name)).toContain(unrelated.name);
      }
    }),
  );

  suite.effect('changed pinned snapshot evidence is rejected without database access', () =>
    Effect.gen(function* changedSnapshotPin() {
      const [manifest] = manifests;
      assert.isOk(manifest !== undefined);
      const [pin] = manifest.snapshots;
      assert.isOk(pin !== undefined);
      const failure = yield* loadConvergentMigrationSource({
        ...manifest,
        snapshots: [[pin[0], '0'.repeat(64)]],
      }).pipe(Effect.flip);
      expect(failure.reason).toBe('Pinned snapshot bytes changed');
    }),
  );

  suite.effect('native failure rolls back without fabricating equivalent journal rows', () =>
    Effect.gen(function* nativeRollback() {
      const sources = yield* loadSources;
      const fixture = nativeFixture([], { failDdl: true });
      const failure = yield* convergeMigrationHistories(sources).pipe(Effect.provide(fixture.layer), Effect.flip);
      expect(failure.reason).toContain('outcome is unknown');
      expect(fixture.ledger.size).toBe(0);
      expect(fixture.events.at(-1)?.text).toBe('ROLLBACK');
    }),
  );

  suite.effect(
    'convergence snapshots retain reviewed security DDL and join both branches without historical edits',
    () =>
      Effect.gen(function* snapshotSecurity() {
        const fs = yield* FileSystem.FileSystem;
        const SnapshotId = Schema.String.check(Schema.isUUID()).pipe(Schema.brand('MigrationSnapshotId'));
        const snapshot = Schema.fromJsonString(
          Schema.Struct({
            ddl: Schema.Array(Schema.Unknown),
            id: SnapshotId,
            prevIds: Schema.Array(SnapshotId),
          }),
        );
        for (const manifest of manifests) {
          const merge = yield* fs
            .readFileString(`${manifest.folder}/${MIGRATION_MERGES[manifest.history]}/snapshot.json`)
            .pipe(Effect.flatMap(Schema.decodeUnknownEffect(snapshot)));
          const heads = {
            contacts: '20261024090301_contacts-gateway-scope-rls',
            core: '20261024223832_gateway-identity-attestation',
            party: '20261024090400_legal-entity-scope',
          } as const;
          const headName = heads[manifest.history];
          const previous = yield* fs
            .readFileString(`${manifest.folder}/${headName}/snapshot.json`)
            .pipe(Effect.flatMap(Schema.decodeUnknownEffect(snapshot)));
          expect(merge.ddl).toEqual(previous.ddl);
          expect(merge.prevIds).toHaveLength(2);
          expect(merge.prevIds).toContain(previous.id);
        }
      }),
  );
});
