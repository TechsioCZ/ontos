import { NodeServices } from '@effect/platform-node';
import { Effect, FileSystem, Path, Schema, SchemaAST } from 'effect';
import { expect, it } from 'effect-rstest';

import { assetDownloadRead } from '../../src/generated-reads/asset-download.ts';
import { AssetDownloadAuthorizationSchema, AssetDownloadRequestSchema } from '../../src/media/download-contract.ts';

/*
 * Static guards of the download surface (#1443, #1436, design-review M9). They read the shipped sources as text on
 * purpose: an absent concept leaves nothing else to assert on, and the claim to prove is exactly that nothing of the
 * kind appeared. They fail when a storage locator reaches a Read result or request, a raw or signed provider URL, a
 * reusable token or a range protocol is introduced, or a scope the issues exclude (bulk, archive, preview, thumbnail,
 * version variant, V2) shows up beside the one governed download.
 */

const readRelative = Effect.fn('CoreMediaDownloadGuards.read')(function* readRelative(relative: string) {
  const [fileSystem, path] = yield* Effect.all([FileSystem.FileSystem, Path.Path], { concurrency: 2 });
  return yield* fileSystem.readFileString(yield* path.fromFileUrl(new URL(`../../${relative}`, import.meta.url)));
});

/** Comments describe what is excluded; only code can contain a forbidden concept. */
const codeOf = (text: string): string =>
  text
    .replaceAll(/\/\*[\s\S]*?\*\//gu, '')
    .replaceAll(/^[\t ]*\/\/.*$/gmu, '')
    .replaceAll(/\s\/\/.*$/gmu, '');

/** Every key of a (nested) Schema struct, so a locator hidden in a sub-object is seen too. */
const fieldNamesOf = (ast: SchemaAST.AST): readonly string[] =>
  SchemaAST.isObjects(ast)
    ? ast.propertySignatures.flatMap(({ name, type }) => [String(name), ...fieldNamesOf(type)])
    : [];

const LOCATOR = /storage|provider|locator|version|\bkey\b|url|uri|bucket|credential|signature|token|etag|path/iu;

/** The files that make up the download: the byte edge, its contract, its headers and the Read that decides. */
const DOWNLOAD_SOURCES = [
  'src/media/download.ts',
  'src/media/download-contract.ts',
  'src/media/download-headers.ts',
  'src/media/integrity-recorder.ts',
  'src/generated-reads/asset-download.ts',
] as const;

it('carries no storage locator, key, version, URL or credential in the Read request or result', () => {
  expect(fieldNamesOf(AssetDownloadAuthorizationSchema.ast).toSorted()).toEqual([
    'byteSize',
    'contentSha256',
    'displayFilename',
    'mediaAssetRef',
    'mimeType',
    'moduleId',
    'resourceId',
    'resourceType',
    'tenantId',
  ]);
  for (const schema of [AssetDownloadRequestSchema, AssetDownloadAuthorizationSchema]) {
    for (const name of fieldNamesOf(schema.ast)) {
      expect(name, `${name} looks like a storage locator`).not.toMatch(LOCATOR);
    }
  }
  expect(assetDownloadRead.descriptor.resultSchema).toBe(AssetDownloadAuthorizationSchema);
  // The request has exactly one field: the asset ref. Nothing names where the bytes live.
  expect(Object.keys(AssetDownloadRequestSchema.fields)).toEqual(['mediaAssetRef']);
  expect(Schema.is(AssetDownloadAuthorizationSchema)({ storageKey: 'x' })).toBe(false);
});

it.layer(NodeServices.layer, { excludeTestServices: true })('the download sources', (suite) => {
  suite.effect('contain no raw or signed provider URL, redirect, reusable token or range protocol', () =>
    Effect.gen(function* noBypass() {
      for (const file of DOWNLOAD_SOURCES) {
        const code = codeOf(yield* readRelative(file));
        for (const [name, pattern] of [
          ['a presigned or signed URL', /presign|signedUrl|getSignedUrl|X-Amz|x-amz|signature/u],
          ['a redirect to the provider', /redirect|\blocation\b|HttpServerResponse\.(?:redirect|temporaryRedirect)/iu],
          ['a reusable token, ticket or link', /\btoken\b|\bticket\b|bearer|reusable|shareable/iu],
          [
            'a range or conditional protocol',
            /accept-ranges|content-range|if-range|if-none-match|\betag\b|last-modified|\b206\b|\b304\b/iu,
          ],
          ['a public or shared cache header', /cache-control.*public|s-maxage|max-age|immutable/iu],
          ['a provider response header passthrough', /headers\s*:\s*\w*\.?stat|\.\.\.\s*opened\.headers/u],
        ] as const) {
          expect(code, `${file} must not contain ${name}`).not.toMatch(pattern);
        }
      }
    }),
  );

  suite.effect('add no bulk, archive, preview, thumbnail, version or V2 variant of the download', () =>
    Effect.gen(function* noForbiddenScope() {
      for (const file of DOWNLOAD_SOURCES) {
        const code = codeOf(yield* readRelative(file));
        expect(code, file).not.toMatch(
          /\b(?:zip|archive|bulk|batch|thumbnail|preview|gallery|ocr|v2|v3|revision|currentPointer|replaceInPlace)\b|Document(?:Version)?\b/iu,
        );
      }
      // One governed download Read exists: not a second declaration for a variant.
      const keys = [
        (yield* readRelative('src/generated-reads/asset-download.ts')).match(/key:\s*'core\.media\.[^']+'/gu),
      ];
      expect(keys.flat()).toEqual(["key: 'core.media.asset-download.read'"]);
    }),
  );

  suite.effect('never hand a storage value to the edge any way but the request-scoped channel of the Read', () =>
    Effect.gen(function* oneChannel() {
      const read = codeOf(yield* readRelative('src/generated-reads/asset-download.ts'));
      // The Read result is the confirmed identity; the stored object's facts are offered, never returned.
      expect(read).toMatch(/source\.offer\(asset\)/u);
      expect(read).not.toMatch(/result:\s*\{[^}]*storage/u);
      const edge = codeOf(yield* readRelative('src/media/edge.ts'));
      expect(edge).not.toMatch(/storageKey|deriveMediaStorageKey/u);
    }),
  );
});
