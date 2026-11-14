import { createHash } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { NodeServices } from '@effect/platform-node';
import { Effect, FileSystem, Option } from 'effect';
import { describe, expect, it } from 'effect-rstest';

import {
  checkOwnerMigrationFolder,
  decideOwnerMigration,
  folderCheckRefusal,
  ownerMigrationSourceOf,
  readLocalMigrations,
} from '../application-migration-pending.mts';
import type { JournalRow, LocalMigration } from '../application-migration-pending.mts';

const sha = (text: string) => createHash('sha256').update(text).digest('hex');
const FIRST = '20261001000000_first';
const SECOND = '20261002000000_second';
const THIRD = '20261003000000_third';
const first: LocalMigration = { hash: sha('first'), name: FIRST };
const second: LocalMigration = { hash: sha('second'), name: SECOND };
const third: LocalMigration = { hash: sha('third'), name: THIRD };
const local: readonly LocalMigration[] = [first, second, third];
const applied = (...migrations: readonly LocalMigration[]): readonly JournalRow[] =>
  migrations.map(({ hash, name }) => ({ hash, name }));
const JOURNAL_COLUMNS = ['id', 'hash', 'created_at', 'name', 'applied_at'];
const decide = (rows: readonly JournalRow[], columns: readonly string[] = JOURNAL_COLUMNS) =>
  decideOwnerMigration({ journal: Option.some({ columns, rows }), local: Option.some(local) });

describe('decideOwnerMigration', () => {
  it('skips the child only when the journal holds every local migration by name and hash', () => {
    const decision = decide(applied(...local));
    expect(decision.nothingToApply).toBe(true);
    expect(decision.pending).toEqual([]);
    expect(decision.reason).toBe('nothing to apply (3 journaled)');
  });

  it('runs the child for the one pending migration', () => {
    expect(decide(applied(first, second))).toEqual({
      nothingToApply: false,
      pending: [THIRD],
      reason: `1 pending (${THIRD})`,
    });
  });

  it('detects an older-named migration added after a newer one was applied, as Drizzle decides by name', () => {
    const decision = decide(applied(first, third));
    expect(decision.nothingToApply).toBe(false);
    expect(decision.pending).toEqual([SECOND]);
  });

  it('runs the child when an applied row carries a different hash than its local SQL', () => {
    const decision = decide([...applied(first, second), { hash: sha('edited third'), name: THIRD }]);
    expect(decision.nothingToApply).toBe(false);
    expect(decision.reason).toBe('a journaled migration differs from its local SQL');
  });

  it('runs the child when the journal table does not exist yet (the first deploy of an owner)', () => {
    const decision = decide([], []);
    expect(decision.nothingToApply).toBe(false);
    expect(decision.reason).toBe('the migration journal does not exist yet');
  });

  it('runs the child for every other doubt', () => {
    const doubts = [
      decideOwnerMigration({ journal: Option.none(), local: Option.some(local) }),
      decideOwnerMigration({ journal: Option.some({ columns: JOURNAL_COLUMNS, rows: [] }), local: Option.none() }),
      // A journal without the `name` column is one Drizzle still upgrades.
      decide(applied(...local), ['id', 'hash', 'created_at']),
      decide([...applied(...local), { hash: sha('first'), name: '' }]),
      decide([...applied(...local), { hash: sha('gone'), name: '20260901000000_gone' }]),
      decide([...applied(...local), { hash: sha('first'), name: FIRST }]),
    ];
    for (const doubt of doubts) {
      expect(doubt.nothingToApply).toBe(false);
    }
  });

  it('treats an owner with no migrations and an empty existing journal as nothing to apply', () => {
    expect(
      decideOwnerMigration({ journal: Option.some({ columns: JOURNAL_COLUMNS, rows: [] }), local: Option.some([]) })
        .nothingToApply,
    ).toBe(true);
  });
});

const WORKSPACE_CONFIG = `import { defineWorkspaceDrizzleConfig } from '../../packages/core-runtime/src/environment/drizzle-config.ts';

export default defineWorkspaceDrizzleConfig({
  out: './drizzle',
  schema: './src/database/schema.ts',
  table: '__drizzle_migrations_tax',
});
`;
const PORTAL_CONFIG = `export default defineConfig({ out: './drizzle-portal-auth', table: '__drizzle_migrations_portal' });`;
const TWO_TABLES = [
  "defineWorkspaceDrizzleConfig({ out: './drizzle', table: '__drizzle_migrations_a',",
  "  other: { table: '__drizzle_migrations_b' } })",
].join('\n');
const UNREVIEWED_TABLE = "defineWorkspaceDrizzleConfig({ out: './drizzle', table: 'Journal' })";

describe('ownerMigrationSourceOf', () => {
  it('reads the workspace configuration shape and nothing else', () => {
    expect(ownerMigrationSourceOf(WORKSPACE_CONFIG)).toEqual(
      Option.some({ folder: 'drizzle', journalName: '__drizzle_migrations_tax' }),
    );
    // Another database, URL or migration table: the planner never reads evidence for it.
    for (const config of [PORTAL_CONFIG, TWO_TABLES, UNREVIEWED_TABLE]) {
      expect(Option.isNone(ownerMigrationSourceOf(config))).toBe(true);
    }
  });
});

describe('readLocalMigrations', () => {
  it.effect('reads the folder as Drizzle does: entries with a migration.sql, hashed over their SQL', () =>
    Effect.gen(function* readsFolder() {
      const fs = yield* FileSystem.FileSystem;
      const folder = yield* fs.makeTempDirectoryScoped();
      yield* fs.makeDirectory(path.join(folder, FIRST));
      yield* fs.writeFileString(path.join(folder, FIRST, 'migration.sql'), 'create table a ();');
      yield* fs.makeDirectory(path.join(folder, 'notes'));
      yield* fs.writeFileString(path.join(folder, 'README.md'), 'not a migration');
      const migrations = yield* readLocalMigrations(fs, folder);
      expect(migrations).toEqual(Option.some([{ hash: sha('create table a ();'), name: FIRST }]));
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect('refuses a folder Drizzle would read differently: an old journal or an unreviewed name', () =>
    Effect.gen(function* refusesFolder() {
      const fs = yield* FileSystem.FileSystem;
      const legacy = yield* fs.makeTempDirectoryScoped();
      yield* fs.makeDirectory(path.join(legacy, 'meta'));
      yield* fs.writeFileString(path.join(legacy, 'meta', '_journal.json'), '{}');
      expect(Option.isNone(yield* readLocalMigrations(fs, legacy))).toBe(true);
      const unnamed = yield* fs.makeTempDirectoryScoped();
      yield* fs.makeDirectory(path.join(unnamed, 'hand-written'));
      yield* fs.writeFileString(path.join(unnamed, 'hand-written', 'migration.sql'), 'select 1;');
      expect(Option.isNone(yield* readLocalMigrations(fs, unnamed))).toBe(true);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );
});

describe('the folder checks a skipped drizzle-kit migrate would have run', () => {
  const taxOwner = fileURLToPath(new URL('../../verticals/tax/', import.meta.url));

  it('passes only an explicit ok from drizzle-kit check', () => {
    expect(Option.isNone(folderCheckRefusal({ dialect: 'postgresql', status: 'ok' }))).toBe(true);
    expect(folderCheckRefusal({ error: { code: 'non_latest' }, status: 'error' })).toEqual(
      Option.some('drizzle-kit check refused the folder (non_latest)'),
    );
    expect(Option.isSome(folderCheckRefusal({ error: { code: 'conflicts' }, status: 'error' }))).toBe(true);
    expect(Option.isSome(folderCheckRefusal(undefined))).toBe(true);
    expect(Option.isSome(folderCheckRefusal({ status: 'unknown' }))).toBe(true);
  });

  it.effect("accepts an owner's real migration folder through the owner's own drizzle-kit", () =>
    Effect.gen(function* acceptsRealFolder() {
      expect(yield* checkOwnerMigrationFolder(taxOwner, path.join(taxOwner, 'drizzle'))).toEqual(Option.none());
    }),
  );

  it.effect('refuses a malformed snapshot, as drizzle-kit migrate would before touching the database', () =>
    Effect.gen(function* refusesMalformedSnapshot() {
      const fs = yield* FileSystem.FileSystem;
      const folder = yield* fs.makeTempDirectoryScoped();
      yield* fs.makeDirectory(path.join(folder, FIRST));
      yield* fs.writeFileString(path.join(folder, FIRST, 'migration.sql'), 'select 1;');
      yield* fs.writeFileString(path.join(folder, FIRST, 'snapshot.json'), '{ not json');
      const refusal = yield* checkOwnerMigrationFolder(taxOwner, folder);
      expect(Option.getOrElse(refusal, () => '')).toContain('malformed');
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect('runs the child when the owner has no drizzle-kit to check with', () =>
    Effect.gen(function* missingDrizzleKit() {
      const fs = yield* FileSystem.FileSystem;
      const owner = yield* fs.makeTempDirectoryScoped();
      yield* fs.writeFileString(path.join(owner, 'package.json'), '{"name":"no-drizzle-kit"}');
      const refusal = yield* checkOwnerMigrationFolder(owner, owner);
      expect(refusal).toEqual(Option.some("the owner's drizzle-kit could not be loaded"));
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );
});
