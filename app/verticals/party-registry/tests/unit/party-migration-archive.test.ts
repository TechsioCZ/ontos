import { fileURLToPath } from 'node:url';

import { NodeFileSystem } from '@effect/platform-node';
import { Effect, FileSystem } from 'effect';
import { expect, it } from 'effect-rstest';

const ownerDirectory = fileURLToPath(new URL('../../', import.meta.url));
const migrationDirectory = `${ownerDirectory}drizzle/`;
const integrationDirectory = `${ownerDirectory}tests/integration/`;

const folderPattern = /^\d{14}_[a-z0-9_-]+$/u;
const quotedFolderPattern = /'(?<folder>\d{14}_[a-z0-9_-]+)'/gu;
const createdTablePattern = /create table(?: if not exists)? "party"\."(?<table>[a-z_]+)"/giu;

/** Rehearsals that must replay the archive whole, and the one that must stop at a historical prefix. */
const fullHistoryRehearsals = [
  'party-assertion-history-preparation.test.ts',
  'verification-removal-migration.test.ts',
] as const;
const prefixRehearsal = 'official-identifier-original-input-migration.test.ts';

/**
 * The demo history re-created the reviewed scope and legal-entity policy folders under later timestamps
 * and marked one equivalence point with a snapshot-only no-op. Every rehearsal pins the 20261020
 * originals, so these are the only archive folders a full rehearsal may leave out.
 */
const replayedByPinnedTwin = [
  ['20261024090300_party-gateway-scope-rls', '20261020063911_party-gateway-scope-rls'],
  ['20261024090400_legal-entity-scope', '20261020113551_legal-entity-scope'],
] as const;
const snapshotOnlyFolders = ['20261027230000_party-migration-equivalence'] as const;

const readText = (path: string) =>
  Effect.gen(function* readTextEffect() {
    const fs = yield* FileSystem.FileSystem;
    return yield* fs.readFileString(path);
  });

const readArchive = Effect.gen(function* readArchiveEffect() {
  const fs = yield* FileSystem.FileSystem;
  const entries = yield* fs.readDirectory(migrationDirectory);
  return entries.filter((entry) => folderPattern.test(entry)).toSorted();
});

/** The folder names a rehearsal declares in an array const, up to its closing `] as const;`. */
const declaredFolders = (source: string, name: string): readonly string[] => {
  const start = source.indexOf(`const ${name}`);
  expect(start, `Expected ${name} in the rehearsal source`).toBeGreaterThanOrEqual(0);
  const end = source.indexOf('] as const;', start);
  expect(end, `Expected ${name} to close with as const`).toBeGreaterThan(start);
  return [...source.slice(start, end).matchAll(quotedFolderPattern)].map((match) => match.groups?.['folder'] ?? '');
};

/** The single folder a rehearsal declares in a scalar const. */
const declaredFolder = (source: string, name: string): string => {
  const start = source.indexOf(`const ${name}`);
  expect(start, `Expected ${name} in the rehearsal source`).toBeGreaterThanOrEqual(0);
  const [first] = [...source.slice(start, source.indexOf(';', start)).matchAll(quotedFolderPattern)];
  expect(first?.groups?.['folder'], `Expected ${name} to declare one migration folder`).toBeTruthy();
  return first?.groups?.['folder'] ?? '';
};

it.layer(NodeFileSystem.layer)('party migration archive', (suite) => {
  suite.effect('stays an ordered, complete archive that exempts only proved duplicates', () =>
    Effect.gen(function* archiveInventory() {
      const fs = yield* FileSystem.FileSystem;
      const entries = yield* fs.readDirectory(migrationDirectory);
      expect(
        entries.filter((entry) => !folderPattern.test(entry)),
        'Every drizzle entry must be a timestamped migration folder',
      ).toEqual([]);
      const archive = entries.toSorted();
      expect(archive.length).toBeGreaterThan(0);
      for (const folder of archive) {
        expect((yield* fs.readDirectory(`${migrationDirectory}${folder}`)).toSorted(), folder).toEqual([
          'migration.sql',
          'snapshot.json',
        ]);
      }
      for (const [duplicate, original] of replayedByPinnedTwin) {
        expect(archive, duplicate).toContain(original);
        expect(
          yield* fs.readFileString(`${migrationDirectory}${duplicate}/migration.sql`),
          `${duplicate} must stay byte-identical to ${original}`,
        ).toBe(yield* fs.readFileString(`${migrationDirectory}${original}/migration.sql`));
      }
      for (const folder of snapshotOnlyFolders) {
        expect(archive, folder).toContain(folder);
        const statements = (yield* fs.readFileString(`${migrationDirectory}${folder}/migration.sql`))
          .split('\n')
          .filter((line) => !line.trimStart().startsWith('--'))
          .join('\n')
          .trim();
        expect(statements, `${folder} must stay snapshot-only`).toBe('select 1;');
      }
    }),
  );

  suite.effect('replays the whole archive in every full-history upgrade rehearsal', () =>
    Effect.gen(function* rehearsalCoverage() {
      const archive = yield* readArchive;
      const expected = archive.filter(
        (folder) =>
          !replayedByPinnedTwin.some(([duplicate]) => duplicate === folder) &&
          !snapshotOnlyFolders.some((marker) => marker === folder),
      );
      for (const rehearsal of fullHistoryRehearsals) {
        const source = yield* readText(`${integrationDirectory}${rehearsal}`);
        const pinned = [
          ...declaredFolders(source, 'baselineFolders'),
          declaredFolder(source, 'structuredNamesFolder'),
          ...declaredFolders(source, 'forwardFolders'),
        ];
        expect(pinned, `${rehearsal} must replay the archive in order`).toEqual(expected);
      }
    }),
  );

  suite.effect('pins a historical prefix that predates the assertion-identity registry', () =>
    Effect.gen(function* prefixCoverage() {
      const archive = yield* readArchive;
      const source = yield* readText(`${integrationDirectory}${prefixRehearsal}`);
      const pinned = [
        ...declaredFolders(source, 'baselineFolders'),
        declaredFolder(source, 'forwardFolder'),
        declaredFolder(source, 'currentNamesFolder'),
      ];
      expect(pinned.length).toBeGreaterThan(0);
      expect(pinned.length).toBeLessThan(archive.length);
      expect(new Set(pinned).size, 'The pinned prefix repeats a folder').toBe(pinned.length);
      expect(
        pinned.filter((folder) => !archive.includes(folder)),
        'Unknown pinned folder',
      ).toEqual([]);
      const positions = pinned.map((folder) => archive.indexOf(folder));
      expect(positions, 'The pinned prefix must follow the archive order').toEqual(
        positions.toSorted((left, right) => left - right),
      );
      // The fixture grants runtime privileges over the tables this prefix actually creates, so the
      // registry that the forward migration installs must not be part of the pinned prefix.
      const pinnedSql = yield* Effect.all(
        pinned.map((folder) => readText(`${migrationDirectory}${folder}/migration.sql`)),
      );
      const created = pinnedSql.flatMap((sql) =>
        [...sql.matchAll(createdTablePattern)].map((match) => match.groups?.['table'] ?? ''),
      );
      expect(created).not.toContain('party_fact_assertion_identities');
      expect(created).not.toContain('party_historical_name_assertions');
      expect(created.length).toBeGreaterThan(0);
    }),
  );
});
