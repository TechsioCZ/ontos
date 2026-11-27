import { NodeServices } from '@effect/platform-node';
import { Effect, FileSystem, Path } from 'effect';
import { expect, it } from 'effect-rstest';

import { ONTOS_SPICEDB_SCHEMA } from '../../src/permissions/schema.ts';

/*
 * Guard for lane d20-08: Core Media has one permission authority, the Core/SpiceDB gate, and owns no other. It reads
 * the shipped sources as text on purpose: an absent concept leaves nothing else to assert on, and the claim to prove
 * is exactly that nothing of the kind appeared. It fails if a media-specific permission check, grant or role table,
 * per-file ACL, decision cache or SpiceDB definition shows up. The behavior (every refused outcome stops the handler,
 * nothing is reused as a grant) is proven against a real SpiceDB in `tests/integration/core-media-authorization.test.ts`.
 */

const readText = Effect.fn('CoreMediaNoAclTest.read')(function* readText(relative: string) {
  const [fileSystem, path] = yield* Effect.all([FileSystem.FileSystem, Path.Path], { concurrency: 2 });
  return yield* fileSystem.readFileString(yield* path.fromFileUrl(new URL(`../../${relative}`, import.meta.url)));
});

const listFiles = Effect.fn('CoreMediaNoAclTest.list')(function* listFiles(relative: string) {
  const [fileSystem, path] = yield* Effect.all([FileSystem.FileSystem, Path.Path], { concurrency: 2 });
  const directory = yield* path.fromFileUrl(new URL(`../../${relative}`, import.meta.url));
  const names = yield* fileSystem.readDirectory(directory);
  return names.filter((name) => name.endsWith('.ts')).map((name) => `${relative}/${name}`);
});

/** Comments describe what is excluded; only code can contain a forbidden concept. */
const codeOf = (text: string): string =>
  text
    .replaceAll(/\/\*[\s\S]*?\*\//gu, '')
    .replaceAll(/^\/\/.*$/gmu, '')
    .replaceAll(/\s\/\/.*$/gmu, '');

const REGISTRATIONS = [
  'src/generated-reads/asset-current.ts',
  'src/generated-reads/asset-download.ts',
  'src/generated-reads/asset-metadata.ts',
  'src/modules/actions/confirm-asset.action.ts',
  'src/modules/actions/rename-display-filename.action.ts',
  'src/modules/actions/upload-asset.action.ts',
  'src/resources/media-asset.ts',
] as const;

/** Only identifiers and operators: string and template literals (the human-readable reasons) are blanked as well. */
const bareOf = (code: string): string =>
  code
    .replaceAll(/'(?:[^'\\\n]|\\.)*'/gu, "''")
    .replaceAll(/"(?:[^"\\\n]|\\.)*"/gu, '""')
    .replaceAll(/`(?:[^`\\]|\\.)*`/gu, '``');

/** Every shipped Core Media source: the media directory and the registrations. */
const mediaSources = Effect.gen(function* mediaSources() {
  const media = yield* listFiles('src/media');
  const files = [...media, ...REGISTRATIONS];
  return yield* Effect.all(
    files.map((file) => readText(file).pipe(Effect.map((text) => [file, codeOf(text)] as const))),
    { concurrency: 'unbounded' },
  );
});

const forbid = (
  sources: readonly (readonly [string, string])[],
  name: string,
  pattern: RegExp,
  view: 'bare' | 'code' = 'bare',
) => {
  for (const [file, code] of sources) {
    expect(view === 'bare' ? bareOf(code) : code, `${file} must not contain ${name}`).not.toMatch(pattern);
  }
};

it.layer(NodeServices.layer, { excludeTestServices: true })('core media owns no permission model', (suite) => {
  suite.effect('has no media-specific permission check, grant, ACL or per-file rule in its code', () =>
    Effect.gen(function* noOwnPermissionCheck() {
      const sources = yield* mediaSources;
      expect(sources.length).toBeGreaterThan(10);
      // `acl` as a word, a snake_case part or a camelCase part (`mediaAcl`, `file_acl`, `ACL`), never inside `oracle`.
      forbid(sources, 'an ACL', /(?:^|[^a-zA-Z])[aA]cl|[a-z0-9]Acl|ACL|AccessControlList/u);
      forbid(sources, 'a permission or grant', /permission|grant|mandate/iu);
      forbid(
        sources,
        'a hand-written access check',
        /canAccess|hasAccess|hasPermission|isAllowed|isAuthorized|isPermitted|checkAccess|authorize/iu,
      );
      forbid(sources, 'an allow-list of principals', /allowed(?:Principal|User)|ownerPrincipalId/u);
    }),
  );

  suite.effect(
    'never calls the gate or reads an access decision itself: the runners ask it, media code only declares',
    () =>
      Effect.gen(function* noGateCalls() {
        const sources = yield* mediaSources;
        // The sources import nothing from the access engine; the declaration shape comes from the entrypoint helpers.
        forbid(sources, 'an access engine import', /from\s+['"][^'"]*\/access\/[^'"]*['"]/u, 'code');
        forbid(sources, 'an AccessDecision', /AccessDecision/u);
        forbid(sources, 'a gate call', /\.\s*decide(?:Many)?\s*\(/u);
        forbid(sources, 'a decision outcome', /['"](?:ALLOWED|DENIED|NEEDS_APPROVAL)['"]/u, 'code');
        // The Current V1 contract names the owner states Catalog consumes (`UNAVAILABLE` is one of them): that is
        // the vocabulary of an owner answer about an asset, never an access decision, so only that file is exempt.
        forbid(
          sources.filter(([file]) => file !== 'src/media/current-contract.ts'),
          'a decision outcome',
          /['"]UNAVAILABLE['"]/u,
          'code',
        );
      }),
  );

  suite.effect('caches no decision and reuses no earlier answer as a grant', () =>
    Effect.gen(function* noDecisionCache() {
      const sources = yield* mediaSources;
      forbid(sources, 'a cache', /(?:^|[^a-zA-Z])cache|Cache|CACHE|memoiz/u);
      // A decision remembered anywhere would need mutable state: media code keeps none.
      forbid(
        sources,
        'a mutable map, ref or cache service',
        /new\s+(?:Weak)?(?:Map|Set)\s*\(|Ref\.(?:make|unsafeMake)|SynchronizedRef|Cache\.make/u,
      );
      forbid(sources, 'a memo table', /(?:\b|_)memo\b|lru|ttl/iu);
      forbid(sources, 'a stored decision', /storedDecision|lastDecision|previousDecision|allowedAt/u);
    }),
  );

  suite.effect('adds only the two media tables and no role, grant, ACL or permission table or column to Core', () =>
    Effect.gen(function* noPermissionTable() {
      const schema = yield* readText('src/db/schema.ts');
      const tables = [...schema.matchAll(/coreSchema\.table\(\s*'(?<table>[^']+)'/gu)].map(
        (match) => match.groups?.['table'] ?? '',
      );
      expect(tables.filter((table) => /media/iu.test(table)).toSorted()).toEqual(['media_assets', 'media_links']);
      // No table of Core is a media (or per-file) permission store.
      expect(
        tables.filter((table) => /(?:acl|media.*(?:grant|role|permission)|(?:grant|permission).*media)/iu.test(table)),
      ).toEqual([]);
      for (const table of ['media_assets', 'media_links']) {
        const start = schema.indexOf(`'${table}'`);
        const end = schema.indexOf('export const', start);
        const definition = schema.slice(start, end === -1 ? undefined : end);
        expect(definition, `${table} must carry no permission column`).not.toMatch(
          /(?:^|[^a-zA-Z])(?:acl|grants?|permissions?|roles?|owner_principal)/u,
        );
        expect(definition, `${table} must carry no permission column`).not.toMatch(
          /[a-z](?:Acl|Grants?|Permissions?|Roles?)/u,
        );
      }
      // Only these tables key on a Media Asset: a new side table (shares, visibility, per-file rules) would fail here.
      const keyedOnAsset = schema
        .split('coreSchema.table(')
        .slice(1)
        .filter((block) => /mediaAssetId\(|mediaAssets\.|'media_asset_id'/u.test(block))
        .map((block) => /^\s*'(?<table>[^']+)'/u.exec(block)?.groups?.['table'] ?? '');
      // `evidence_references` is the Evidence module's older table that may point at an asset; it is not a permission store.
      expect(keyedOnAsset.toSorted()).toEqual(['evidence_references', 'media_assets', 'media_links']);
    }),
  );

  suite.effect('creates no media table in any migration beyond the two, and none for permissions', () =>
    Effect.gen(function* noMigrationTable() {
      const [fileSystem, path] = yield* Effect.all([FileSystem.FileSystem, Path.Path], { concurrency: 2 });
      const directory = yield* path.fromFileUrl(new URL('../../drizzle/', import.meta.url));
      const created: string[] = [];
      for (const name of yield* fileSystem.readDirectory(directory)) {
        const file = `${directory}/${name}/migration.sql`;
        if (yield* fileSystem.exists(file)) {
          const sql = yield* fileSystem.readFileString(file);
          created.push(
            ...[...sql.matchAll(/CREATE TABLE "core"\."(?<table>[^"]+)"/gu)].map(
              (match) => match.groups?.['table'] ?? '',
            ),
          );
        }
      }
      expect(created.filter((table) => /media/iu.test(table)).toSorted()).toEqual(['media_assets', 'media_links']);
      expect(created.filter((table) => /(?:acl|media.*(?:grant|role|permission))/iu.test(table))).toEqual([]);
    }),
  );

  suite.effect('leaves the SpiceDB model untouched: no media definition, relation or bootstrap fixture', () =>
    Effect.gen(function* noSpiceDbChange() {
      expect(ONTOS_SPICEDB_SCHEMA).not.toMatch(/media/iu);
      for (const fixture of [
        'spicedb/bootstrap.yaml',
        'spicedb/stage-bootstrap.yaml',
        'spicedb/external-identity-permissions.test.yaml',
      ]) {
        expect(yield* readText(fixture), fixture).not.toMatch(/media/iu);
      }
    }),
  );
});
