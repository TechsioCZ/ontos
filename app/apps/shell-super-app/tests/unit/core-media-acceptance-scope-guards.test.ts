import { NodeServices } from '@effect/platform-node';
import { Effect, FileSystem, Path } from 'effect';
import { expect, it } from 'effect-rstest';

/*
 * STRUCTURAL GUARD. The scope of Core Media excludes a set of concepts
 * (#1431, #1437 to #1441, #1444 are closed `not_planned`; ADR-0031): a Document or DocumentVersion store, V2+ and
 * revision publishing, an own ACL, a raw reusable provider URL or a public CDN, a physical delete, a UI, a product
 * size cap or MIME allowlist, a new MicroVertical. An absent concept leaves nothing to assert on but its absence, so
 * this test reads the SHIPPED source as text, on purpose, across the whole surface the earlier per-lane guards left
 * unscanned (the S3 adapter and its signer, the byte edge, the Shell host and its hosted-operation receiver, the
 * Catalog binding, every Core migration and the UI sources). It judges Core Media's own surfaces and what reaches
 * them, never a name another domain may take: a documents or gallery feature of its own is not Core Media's
 * business. Comments are stripped first: they name what is
 * excluded, and only code can contain it. The behavior rules these guards stand beside are proven by executed
 * tests; nothing here claims one.
 */

const APP_ROOT = new URL('../../../../', import.meta.url);

const SKIPPED_DIRECTORIES: ReadonlySet<string> = new Set(['.git', '.output', 'dist', 'node_modules']);

const CODE_FILE = /\.(?:ts|tsx|mts)$/u;

/** Comments describe what is excluded; only code can contain a forbidden concept. */
const codeOf = (text: string): string =>
  text
    .replaceAll(/\/\*[\s\S]*?\*\//gu, '')
    .replaceAll(/^[\t ]*\/\/.*$/gmu, '')
    .replaceAll(/\s\/\/.*$/gmu, '');

const pathOf = Effect.fn('CoreMediaScopeGuards.path')(function* pathOf(relative: string) {
  const path = yield* Path.Path;
  return yield* path.fromFileUrl(new URL(relative, APP_ROOT)).pipe(Effect.orDie);
});

const readText = Effect.fn('CoreMediaScopeGuards.read')(function* readText(relative: string) {
  const fileSystem = yield* FileSystem.FileSystem;
  return yield* fileSystem.readFileString(yield* pathOf(relative));
});

/** Every file below a directory (relative to `app/`), in a stable order. */
const walk = Effect.fn('CoreMediaScopeGuards.walk')(function* walk(
  relative: string,
): Effect.fn.Return<string[], never, FileSystem.FileSystem | Path.Path> {
  const fileSystem = yield* FileSystem.FileSystem;
  const found: string[] = [];
  const names = (yield* fileSystem.readDirectory(yield* pathOf(relative)).pipe(Effect.orDie)).toSorted();
  for (const name of names) {
    if (SKIPPED_DIRECTORIES.has(name)) {
      continue;
    }
    const child = `${relative}/${name}`;
    const info = yield* fileSystem.stat(yield* pathOf(child)).pipe(Effect.orDie);
    if (info.type === 'Directory') {
      found.push(...(yield* walk(child)));
    } else {
      found.push(child);
    }
  }
  return found;
});

const PRODUCT_ROOTS = {
  catalog: 'verticals/catalog/src/integrations/core-media-owner.ts',
  coreActions: 'packages/core-runtime/src/modules/actions',
  coreMedia: 'packages/core-runtime/src/media',
  coreReads: 'packages/core-runtime/src/generated-reads',
} as const;

const SHELL_MEDIA_FILES = [
  'apps/shell-super-app/api/index.ts',
  'apps/shell-super-app/api/core-hosted-operations.ts',
  'apps/shell-super-app/shared/core-hosted-operations.ts',
  'apps/shell-super-app/shared/core-actions/upload-asset.ts',
  'apps/shell-super-app/shared/core-actions/confirm-asset.ts',
  'apps/shell-super-app/shared/core-actions/rename-display-filename.ts',
  'apps/shell-super-app/shared/core-reads/asset-metadata.ts',
] as const;

const MEDIA_ACTION_FILES = [
  'upload-asset.action.ts',
  'confirm-asset.action.ts',
  'rename-display-filename.action.ts',
  'record-asset-integrity-failure.action.ts',
] as const;

const MEDIA_READ_FILES = [
  'asset-metadata.ts',
  'asset-current.ts',
  'asset-download.ts',
  'asset-byte-source.ts',
] as const;

/** The Core Media product source as `[file, code]`: the capability itself, never a test. */
const loadCoreMediaCode = Effect.fn('CoreMediaScopeGuards.coreMedia')(function* loadCoreMediaCode() {
  const mediaFiles = (yield* walk(PRODUCT_ROOTS.coreMedia)).filter((file) => CODE_FILE.test(file));
  const files = [
    ...mediaFiles,
    ...MEDIA_ACTION_FILES.map((name) => `${PRODUCT_ROOTS.coreActions}/${name}`),
    ...MEDIA_READ_FILES.map((name) => `${PRODUCT_ROOTS.coreReads}/${name}`),
    PRODUCT_ROOTS.catalog,
  ];
  return yield* Effect.all(
    files.map((file) => readText(file).pipe(Effect.map((text) => [file, codeOf(text)] as const))),
    { concurrency: 1 },
  );
});

const loadShellMediaCode = Effect.all(
  SHELL_MEDIA_FILES.map((file) => readText(file).pipe(Effect.map((text) => [file, codeOf(text)] as const))),
  { concurrency: 1 },
);

/** A statement that creates or alters a media table. */
const MEDIA_TABLE_STATEMENT =
  /^\s*(?:create|alter) table (?:if (?:not )?exists )?(?:only )?(?:"?core"?\.)?"?(?<table>media_\w+)"?/iu;
/** A column definition of a CREATE TABLE body, and a column an ALTER TABLE adds or renames to. */
const CREATED_COLUMN = /^\s*"?(?<column>\w+)"?\s+\S/u;
const ALTERED_COLUMN = /\b(?:add(?: column)?(?: if not exists)?|rename(?: column)? "?\w+"? to)\s+"?(?<column>\w+)"?/giu;
const TABLE_CONSTRAINT_WORD = /^(?:constraint|primary|unique|check|foreign|exclude|like)$/iu;
/** What a column holding a version, a revision, a Current pointer or a replacement chain would be called. */
const REVISION_LIKE =
  /revision|version|(?:^|_)rev(?:_|$)|current|publi|supersed|replac|previous|predecessor|document/iu;

/** Every `table.column` a migration gives a media table. */
const mediaColumnsOf = (sql: string): readonly string[] =>
  sql
    .replaceAll('--> statement-breakpoint', '')
    .split(';')
    .flatMap((statement) => {
      const table = MEDIA_TABLE_STATEMENT.exec(statement)?.groups?.['table'];
      if (table === undefined) {
        return [];
      }
      const columns = /^\s*create/iu.test(statement)
        ? statement
            .slice(statement.indexOf('(') + 1)
            .split(/[,\n]/u)
            .map((part) => CREATED_COLUMN.exec(part)?.groups?.['column'])
        : [...statement.matchAll(ALTERED_COLUMN)].map((match) => match.groups?.['column']);
      return columns
        .filter((column) => column !== undefined && !TABLE_CONSTRAINT_WORD.test(column))
        .map((column) => `${table}.${column}`);
    });

/** The Core Media routes. */
const CORE_MEDIA_ROUTE =
  /core\/(?:media|operations\/asset-current|actions\/(?:upload-asset|confirm-asset|rename-display-filename)|reads\/asset-metadata)/u;
/** The other ways to them: the generated browser client's functions, its contracts and the Core Media modules. */
const CORE_MEDIA_CLIENT =
  /\bexecute(?:UploadAsset|ConfirmAsset|RenameDisplayFilename|AssetMetadata)\b|\bcore(?:Action(?:UploadAsset|ConfirmAsset|RenameDisplayFilename)|ReadAssetMetadata)\b|core-(?:actions|reads)\/(?:upload-asset|confirm-asset|rename-display-filename|asset-metadata)|@app\/core-runtime\/media\b/u;
/** The generated Shell browser client: it declares the Core Media calls and is no UI. */
const SHELL_BROWSER_CLIENT = 'apps/shell-super-app/src/api/auth-client.ts';

/** Every `.tsx` file in the `src` of each package below `root`. */
const componentsOf = Effect.fn('CoreMediaScopeGuards.components')(function* componentsOf(root: string) {
  const fileSystem = yield* FileSystem.FileSystem;
  const found: string[] = [];
  for (const name of (yield* fileSystem.readDirectory(yield* pathOf(root)).pipe(Effect.orDie)).toSorted()) {
    const source = `${root}/${name}/src`;
    const directory = yield* pathOf(source);
    if (yield* fileSystem.exists(directory).pipe(Effect.orDie)) {
      const files = yield* fileSystem.readDirectory(directory, { recursive: true }).pipe(Effect.orDie);
      found.push(...files.filter((file) => file.endsWith('.tsx')).map((file) => `${source}/${file}`));
    }
  }
  return found;
});

const forbid = (sources: readonly (readonly [string, string])[], name: string, pattern: RegExp) => {
  for (const [file, code] of sources) {
    expect(code, `${file} must not contain ${name}`).not.toMatch(pattern);
  }
};

it.layer(NodeServices.layer, { excludeTestServices: true })('core media scope guards (structural)', (suite) => {
  // L1447-D24, L1447-H20, L1443-H17
  suite.effect(
    'has no Document aggregate, version store, Current pointer or revision publishing anywhere in the shipped code',
    () =>
      Effect.gen(function* noDocuments() {
        const sources = [...(yield* loadCoreMediaCode()), ...(yield* loadShellMediaCode)];
        forbid(
          sources,
          'a Document version',
          /DocumentVersion|document_versions?\b|documentVersions?\b|core\.documents\b/iu,
        );
        forbid(sources, 'a revision id', /\brevisionId\b|\brevision_id\b/u);
        forbid(
          sources,
          'a Current pointer or publication',
          /\b(?:currentPointer|setCurrent|switchCurrent|publishRevision)\b/u,
        );
        forbid(sources, 'replace-in-place', /\breplaceInPlace\b|\boverwriteInPlace\b/u);
      }),
  );

  suite.effect(
    'has no raw reusable storage URL, signed URL, redirect or public CDN in the capability or its Shell host',
    () =>
      Effect.gen(function* noRawUrls() {
        const sources = [...(yield* loadCoreMediaCode()), ...(yield* loadShellMediaCode)];
        forbid(
          sources,
          'a presigned or signed URL',
          /presign|X-Amz-(?:Signature|Expires|Credential)|signedUrl|signed_url/iu,
        );
        forbid(sources, 'a CDN or public bucket URL', /\bcdn\b|cloudfront|publicUrl|public_url|\br2\.dev\b/iu);
        // The byte hops (core-runtime `media/edge.ts` and its siblings) answer bytes themselves: no media code points a
        // client at another location. The Shell `api/index.ts` only composes them and also serves unrelated redirects.
        forbid(
          sources.filter(([file]) => file !== 'apps/shell-super-app/api/index.ts'),
          'a redirect',
          /Response\.redirect|\bLocation\b|status:\s*30[1-8]\b/u,
        );
      }),
  );

  suite.effect(
    'has no physical delete: the one HTTP DELETE is the adapter aborting its own unfinished multipart upload',
    () =>
      Effect.gen(function* noDelete() {
        const media = yield* loadCoreMediaCode();
        forbid(media, 'a DeleteObject or removal', /DeleteObject|deleteObject|removeObject|\bpurge\w*|\.delete\(/u);
        const adapter = media.find(([file]) => file.endsWith('s3-object-storage.ts'));
        expect(adapter).toBeDefined();
        const deletes = media.flatMap(([file, code]) =>
          [...code.matchAll(/method:\s*'DELETE'(?!\s*\|)/gu)].map(() => file),
        );
        expect(deletes).toEqual([adapter?.[0]]);
        // It sits inside `abortUpload`, which only ever names an upload id: never a stored object's key alone.
        expect(adapter?.[1]).toMatch(
          /const abortUpload = \([^)]*uploadId: string\)[\s\S]{0,300}method:\s*'DELETE'[\s\S]{0,200}\{ uploadId \}/u,
        );
        // No Shell route of Core Media is a DELETE route either.
        forbid(yield* loadShellMediaCode, 'a DELETE route', /method:\s*'DELETE'|\.delete\(\s*['"`]\//u);
      }),
  );

  suite.effect('imposes no product size cap, MIME allowlist, retry schedule or scanner in the capability', () =>
    Effect.gen(function* noInventedPolicy() {
      const media = yield* loadCoreMediaCode();
      forbid(
        media,
        'a size ceiling',
        /\b(?:maxBytes|maxSize|sizeLimit|maxUpload\w*|MAX_UPLOAD\w*|maximumUpload\w*)\b/iu,
      );
      forbid(media, 'a MIME allowlist', /allowlist|whitelist|allowedMime\w*|ALLOWED_MIME\w*/iu);
      forbid(media, 'a retry or schedule', /Effect\.retry|Effect\.repeat|\bSchedule\./u);
      forbid(media, 'a malware scanner', /\b(?:clamav|virus\w*|malware\w*|antivirus)\b/iu);
    }),
  );

  suite.effect(
    'adds no Core table beyond media assets and media links, no revision-like column on them, and no document or revision table in any migration',
    () =>
      Effect.gen(function* noExtraTables() {
        const migrations = (yield* walk('packages/core-runtime/drizzle')).filter((file) =>
          file.endsWith('migration.sql'),
        );
        expect(migrations.length).toBeGreaterThan(0);
        const created = new Set<string>();
        const columns = new Set<string>();
        for (const file of migrations) {
          // A commented-out statement is not a table.
          const sql = (yield* readText(file)).replaceAll(/^[\t ]*--.*$/gmu, '');
          for (const match of sql.matchAll(/create table (?:if not exists )?"?(?:core"?\.)?"?(?<table>\w+)"?/giu)) {
            created.add(match.groups?.['table'] ?? '');
          }
          for (const column of mediaColumnsOf(sql)) {
            columns.add(column);
          }
        }
        // The only media tables ever created in Core: the asset and the link a business owner writes.
        expect([...created].filter((name) => /media/iu.test(name)).toSorted()).toEqual(['media_assets', 'media_links']);
        // Both tables' columns were read, and the one revision-like name among them is the provider's technical pin of
        // the stored object: integrity evidence, never a version of the asset.
        expect([...columns]).toEqual(
          expect.arrayContaining(['media_assets.processing_status', 'media_links.link_kind']),
        );
        expect([...columns].filter((column) => REVISION_LIKE.test(column))).toEqual([
          'media_assets.storage_object_version_ref',
        ]);
        // Other owners' revision tables (the access role revisions) exist; none belongs to a document or an asset.
        expect(
          [...created].filter((name) => /document|(?:media|asset|file)\w*(?:revision|version)/iu.test(name)),
        ).toEqual([]);
      }),
  );

  suite.effect('has no Core Media UI: no UI source reaches it and its own source directory holds no UI file', () =>
    Effect.gen(function* noUi() {
      const shellSources = (yield* walk('apps/shell-super-app/src')).filter((file) => CODE_FILE.test(file));
      const components = (yield* Effect.all(['apps', 'packages', 'verticals'].map(componentsOf), {
        concurrency: 1,
      })).flat();
      expect(components.length).toBeGreaterThan(0);
      // The control: the client patterns recognise the Core Media calls the generated client really declares.
      expect(shellSources).toContain(SHELL_BROWSER_CLIENT);
      expect(codeOf(yield* readText(SHELL_BROWSER_CLIENT))).toMatch(CORE_MEDIA_CLIENT);
      for (const file of new Set([...shellSources, ...components])) {
        const code = codeOf(yield* readText(file));
        expect(code, `${file} must not call a Core Media route`).not.toMatch(CORE_MEDIA_ROUTE);
        if (file !== SHELL_BROWSER_CLIENT) {
          expect(code, `${file} must not use a Core Media client or contract`).not.toMatch(CORE_MEDIA_CLIENT);
        }
      }
      const own = yield* walk(PRODUCT_ROOTS.coreMedia);
      expect(own.filter((file) => /\.(?:tsx|css|html)$/u.test(file))).toEqual([]);
    }),
  );

  suite.effect('gives Core Media no deployable of its own: no vertical or app is named for it or takes its id', () =>
    Effect.gen(function* noNewVertical() {
      const fileSystem = yield* FileSystem.FileSystem;
      for (const root of ['verticals', 'apps']) {
        const names = yield* fileSystem.readDirectory(yield* pathOf(root)).pipe(Effect.orDie);
        expect(names.filter((name) => /core-?media|media-?assets?/iu.test(name))).toEqual([]);
      }
      for (const name of yield* fileSystem.readDirectory(yield* pathOf('verticals')).pipe(Effect.orDie)) {
        const manifest = yield* readText(`verticals/${name}/vertical.manifest.ts`).pipe(Effect.orDie);
        const moduleId = /^\/\/ @ontos-module-id (?<id>\S+)$/mu.exec(manifest)?.groups?.['id'];
        expect(moduleId, `${name} states its module id`).toBeDefined();
        expect(moduleId, `${name} must not take the Core Media module id`).not.toMatch(/^core\.media(?:\.|$)/u);
      }
    }),
  );
});
