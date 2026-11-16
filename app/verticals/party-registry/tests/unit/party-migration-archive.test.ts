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

/** Rehearsals that pin the whole trunk chain, and the one that pins only a historical prefix. */
const fullHistoryRehearsals = [
  'party-assertion-history-preparation.test.ts',
  'verification-removal-migration.test.ts',
] as const;
const prefixRehearsal = 'official-identifier-original-input-migration.test.ts';
/** Every rehearsal continues past its pinned folders through the canonical owner migration, as a deploy does. */
const canonicalContinuation = "preparePartyReconciliationNative(isolated.connections, 'migrate')";

/**
 * The Party chain stage had applied from the demo trunk when main merged in (trunk e853a3db1; its Party
 * folders are unchanged at eee67d0e4). The demo history re-created the reviewed scope and legal-entity
 * policy folders under later timestamps; convergence applies exactly one naming lineage, and every
 * rehearsal pins the 20261020 originals, so those twins are the only trunk folders a rehearsal leaves out.
 */
const trunkChain = [
  '20260903174425_yummy_glorian',
  '20260904104109_nebulous_cardiac',
  '20260914161805_marvelous_spirit',
  '20261019115249_official_identifier_original_input',
  '20261020063911_party-gateway-scope-rls',
  '20261020113551_legal-entity-scope',
  '20261024090300_party-gateway-scope-rls',
  '20261024090400_legal-entity-scope',
  '20261027230000_party-migration-equivalence',
  '20261105082358_flashy_gravity',
  '20261105154254_young_magik',
  '20261105154619_left_vin_gonzales',
  '20261106083603_aberrant_gauntlet',
  '20261106120000_party-migration-convergence',
  '20261109093237_party-fact-assertion-identities',
] as const;
const replayedByPinnedTwin = [
  ['20261024090300_party-gateway-scope-rls', '20261020063911_party-gateway-scope-rls'],
  ['20261024090400_legal-entity-scope', '20261020113551_legal-entity-scope'],
] as const;
/**
 * Main's Party folders the trunk had not applied. Native Drizzle applies every folder its journal lacks,
 * so the canonical migration appends these after the trunk chain even where they sort before its last
 * folder, and the merge's snapshot-only leaf closes the convergence.
 */
const mainFolders = [
  '20261106142207_party-create-source-receipts',
  '20261107095844_party-source-effects-and-ico-fence',
  '20261107100007_legacy-ico-authority-guards',
  '20261107100251_party-source-receipt-reference',
  '20261107104047_party-source-lifecycle-receipt-operations',
  '20261110134527_ico-correlation-epochs',
] as const;
const convergenceLeaf = '20261112002651_main-c14-convergence';
const snapshotOnlyFolders = ['20261027230000_party-migration-equivalence', convergenceLeaf] as const;

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

  suite.effect('pins the trunk chain stage has applied, then leaves main and the leaf to the canonical migration', () =>
    Effect.gen(function* stageOrderCoverage() {
      const archive = yield* readArchive;
      expect(
        trunkChain.filter((folder) => !archive.includes(folder)),
        'Every trunk folder stays archived',
      ).toEqual([]);
      expect(
        archive.filter((folder) => folder <= convergenceLeaf && !trunkChain.some((trunk) => trunk === folder)),
        'After the trunk chain, stage applies exactly main and then the convergence leaf',
      ).toEqual([...mainFolders, convergenceLeaf]);
      const pinnedTrunk = trunkChain.filter(
        (folder) => !replayedByPinnedTwin.some(([duplicate]) => duplicate === folder),
      );
      for (const rehearsal of fullHistoryRehearsals) {
        const source = yield* readText(`${integrationDirectory}${rehearsal}`);
        const pinned = [
          ...declaredFolders(source, 'baselineFolders'),
          declaredFolder(source, 'structuredNamesFolder'),
          ...declaredFolders(source, 'forwardFolders'),
        ];
        expect(pinned, `${rehearsal} must pin the trunk chain in order`).toEqual(pinnedTrunk);
        expect(
          source.indexOf(canonicalContinuation),
          `${rehearsal} must continue through the canonical owner migration after its pinned folders`,
        ).toBeGreaterThan(source.lastIndexOf('yield* migrate('));
      }
    }),
  );

  suite.effect('pins a historical prefix that predates the assertion-identity registry', () =>
    Effect.gen(function* prefixCoverage() {
      const archive = yield* readArchive;
      const source = yield* readText(`${integrationDirectory}${prefixRehearsal}`);
      const pinned = [...declaredFolders(source, 'baselineFolders'), declaredFolder(source, 'forwardFolder')];
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
      expect(
        source.indexOf(canonicalContinuation),
        'The prefix must continue through the canonical owner migration after its pinned folders',
      ).toBeGreaterThan(source.lastIndexOf('yield* migrate('));
    }),
  );
});
