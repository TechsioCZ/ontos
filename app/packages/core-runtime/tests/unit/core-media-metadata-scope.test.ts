import { NodeServices } from '@effect/platform-node';
import { Effect, FileSystem, Path } from 'effect';
import { expect, it } from 'effect-rstest';

import { assetMetadataRead, renameDisplayFilenameAction } from '../../src/index.ts';
import { MediaAssetMetadataSchema } from '../../src/media/public-contract.ts';

/*
 * Guards for what the metadata and rename lane must not contain: a list, search, gallery, preview or bulk read, a
 * field that could stand in for a revision, a generic edit-asset operation, a storage value on the public answer,
 * and any link or Catalog effect of a rename. Sources are read as text on purpose: an absent concept leaves
 * nothing else to assert on.
 */

const source = Effect.fn('CoreMediaMetadataScopeTest.source')(function* source(relative: string) {
  const [fileSystem, path] = yield* Effect.all([FileSystem.FileSystem, Path.Path], { concurrency: 2 });
  return yield* fileSystem.readFileString(yield* path.fromFileUrl(new URL(`../../src/${relative}`, import.meta.url)));
});

/** Comments describe what is excluded; only code can contain a forbidden concept. */
const codeOf = (text: string): string =>
  text
    .replaceAll(/\/\*[\s\S]*?\*\//gu, '')
    .replaceAll(/^[\t ]*\/\/.*$/gmu, '')
    .replaceAll(/\s\/\/.*$/gmu, '');

const LANE_SOURCE_PATHS = [
  'generated-reads/asset-metadata.ts',
  'media/rename-contract.ts',
  'modules/actions/rename-display-filename.action.ts',
] as const;

const loadLaneSources = Effect.all(
  LANE_SOURCE_PATHS.map((relative) => source(relative).pipe(Effect.map((text) => [relative, codeOf(text)] as const))),
  { concurrency: 'unbounded' },
);

const forbid = (sources: readonly (readonly [string, string])[], name: string, pattern: RegExp) => {
  for (const [file, code] of sources) {
    expect(code, `${file} must not contain ${name}`).not.toMatch(pattern);
  }
};

it.layer(NodeServices.layer, { excludeTestServices: true })('core media metadata and rename scope guards', (suite) => {
  suite.effect('has no list, search, gallery, preview, bulk or paging concept', () =>
    Effect.gen(function* noBrowsing() {
      const sources = yield* loadLaneSources;
      forbid(
        sources,
        'a list or search',
        /\b(?:list|search|query|filter|sort|order(?:By)?|paginat\w*|cursor|offset)\b/iu,
      );
      forbid(sources, 'a gallery or preview', /\b(?:gallery|preview|thumbnail|library)\b/iu);
      forbid(sources, 'a bulk or batch operation', /\b(?:bulk|batch)\b/iu);
    }),
  );

  suite.effect('names no storage column, signed or raw URL, or credential in the metadata read or the rename', () =>
    Effect.gen(function* noStorage() {
      const sources = yield* loadLaneSources;
      forbid(sources, 'a storage column', /\b(?:storageProvider|storageKey|storageObjectVersionRef)\b/u);
      forbid(sources, 'a URL or credential', /\b(?:signedUrl|presign\w*|credential\w*|secret|https?:)/iu);
      forbid(sources, 'a byte read', /\bObjectStorage\b|\bStream\b|\bUint8Array\b/u);
    }),
  );

  suite.effect('has no document, version, revision, replace or Current concept', () =>
    Effect.gen(function* noVersions() {
      const sources = yield* loadLaneSources;
      forbid(sources, 'a Document concept', /\bdocuments?\b/iu);
      forbid(sources, 'a version concept', /\b(?:document)?version(?:s|ing)?\b/iu);
      forbid(sources, 'a revision', /\brevision(?:id)?\b/iu);
      forbid(sources, 'a replace or publish operation', /\b(?:replace|publish|supersede)\w*/iu);
      forbid(sources, 'a Current pointer', /\bcurrent\b/iu);
    }),
  );

  suite.effect('has no link, Catalog or assignment effect, no event or outbox, no delete', () =>
    Effect.gen(function* noEffects() {
      const sources = yield* loadLaneSources;
      forbid(sources, 'a media link', /\bmedia_?links?\b|\blinkSource\b|\blinkKind\b/iu);
      forbid(sources, 'a catalog or product assignment', /\b(?:catalog|product|variant|assign\w*)\b/iu);
      forbid(sources, 'a domain event or outbox', /\baddDomainEvent\b|\baddOutboxMessage\b|\boutbox\b/iu);
      forbid(sources, 'a delete', /\bdelete\w*|\.delete\(/iu);
      forbid(sources, 'a status transition', /\btransition\b|processingStatus:\s*['"]/u);
    }),
  );

  suite.effect('writes only the display file name: the repository rename sets that column and the timestamp', () =>
    Effect.gen(function* onlyDisplayName() {
      const repository = codeOf(yield* source('media/repository.ts'));
      const rename = repository.slice(repository.indexOf('renameDisplayFilename'), repository.indexOf('reserve:'));
      expect(rename).toMatch(/\.set\(\{ displayFilename, updatedAt: now \}\)/u);
      for (const column of [
        'originalFilename',
        'byteSize',
        'contentSha256',
        'sealedAt',
        'processingStatus',
        'ingestionSource',
        'legalEntityId',
        'tenantId:',
        'mediaAssetId:',
        'mimeType',
        'storage',
      ]) {
        expect(rename, `the rename statement must not set ${column}`).not.toContain(`${column}:`);
      }
    }),
  );
});

it('reads exactly one record by its exact ref: a detail read with an access target, never a list', () => {
  // The read is a single exact-record detail read: a list, search or report read cannot declare an access target.
  expect(assetMetadataRead.descriptor.accessKind).toBe('detail');
  expect(assetMetadataRead.descriptor.accessTarget).toBeDefined();
  expect(renameDisplayFilenameAction.descriptor.accessTarget).toBeDefined();
});

it('has no field on the metadata answer or the rename result that could stand in for a revision or a storage value', () => {
  const metadataFields = Object.keys(MediaAssetMetadataSchema.fields);
  const renameFields = Object.keys(renameDisplayFilenameAction.descriptor.resultSchema.fields);
  for (const field of [
    'revision',
    'revisionId',
    'version',
    'versionId',
    'current',
    'storageObjectVersionRef',
    'storageProvider',
    'storageKey',
    'url',
    'signedUrl',
    'credentials',
    'locator',
  ]) {
    expect(metadataFields).not.toContain(field);
    expect(renameFields).not.toContain(field);
  }
  // The only identity-bearing field is the owner-qualified ref; the content fields exist only as verified values.
  expect(metadataFields.toSorted()).toEqual([
    'byteSize',
    'contentSha256',
    'contentVerified',
    'displayFilename',
    'ingestionSource',
    'mediaAssetRef',
    'mimeType',
    'originalFilename',
    'processingStatus',
  ]);
});
