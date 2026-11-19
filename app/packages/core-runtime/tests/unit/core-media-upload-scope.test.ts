import { NodeServices } from '@effect/platform-node';
import { Effect, FileSystem, Path } from 'effect';
import { expect, it } from 'effect-rstest';

import { confirmAssetAction, coreActionCatalog, uploadAssetAction } from '../../src/index.ts';

/*
 * Guards for what the upload lane must not contain: the closed or not-planned scope of Core Media (#1431,
 * #1437 to #1441: no version store, no replace, no delete, no link or assignment, no UI, no search, no preview)
 * and the rules the owner did not ask for (no product size cap, no MIME allowlist, no scanner, no invented
 * timeout or retry value). They read the shipped upload sources as text on purpose: an absent concept leaves
 * nothing else to assert on.
 */

const source = Effect.fn('CoreMediaScopeTest.source')(function* source(relative: string) {
  const [fileSystem, path] = yield* Effect.all([FileSystem.FileSystem, Path.Path], { concurrency: 2 });
  return yield* fileSystem.readFileString(yield* path.fromFileUrl(new URL(`../../src/${relative}`, import.meta.url)));
});

/** Comments describe what is excluded; only code can contain a forbidden concept. */
const codeOf = (text: string): string =>
  text
    .replaceAll(/\/\*[\s\S]*?\*\//gu, '')
    .replaceAll(/^\s*\/\/.*$/gmu, '')
    .replaceAll(/\s\/\/.*$/gmu, '');

const UPLOAD_SOURCE_PATHS = [
  'media/byte-stream.ts',
  'media/content-tally.ts',
  'media/upload-contract.ts',
  'media/verification.ts',
  'modules/actions/confirm-asset.action.ts',
  'modules/actions/upload-asset.action.ts',
] as const;

const loadUploadSources = Effect.all(
  UPLOAD_SOURCE_PATHS.map((relative) => source(relative).pipe(Effect.map((text) => [relative, codeOf(text)] as const))),
  { concurrency: 'unbounded' },
);

const forbid = (sources: readonly (readonly [string, string])[], name: string, pattern: RegExp) => {
  for (const [file, code] of sources) {
    expect(code, `${file} must not contain ${name}`).not.toMatch(pattern);
  }
};

it.layer(NodeServices.layer, { excludeTestServices: true })('core media upload scope guards', (suite) => {
  suite.effect('has no document, version, revision or Current concept in the upload code', () =>
    Effect.gen(function* noDocumentConcepts() {
      const sources = yield* loadUploadSources;
      forbid(sources, 'a Document concept', /\bdocuments?\b/iu);
      forbid(sources, 'a version concept', /\b(?:document)?version(?:s|ing)?\b/iu);
      forbid(sources, 'a revision', /\brevision(?:id)?\b/iu);
      forbid(sources, 'a replace or publish operation', /\b(?:replace|publish|supersede)\w*/iu);
      forbid(sources, 'a V2', /\bv2\b/iu);
    }),
  );

  suite.effect('has no physical delete or overwrite of a confirmed object, and the port has none to call', () =>
    Effect.gen(function* noDelete() {
      const sources = yield* loadUploadSources;
      forbid(sources, 'a delete', /\bdelete\w*/iu);
      forbid(sources, 'a drizzle delete', /\.delete\(/u);
      forbid(sources, 'a remove or purge', /\b(?:remove|purge|unlink|evict)\w*/iu);
      expect(codeOf(yield* source('media/object-storage.ts'))).not.toMatch(/\bdelete\b|\bremove\b|\boverwrite\b/iu);
    }),
  );

  suite.effect('creates no media link, no catalog assignment and no event or outbox message', () =>
    Effect.gen(function* noLinks() {
      const sources = yield* loadUploadSources;
      forbid(sources, 'a media link', /\bmedia_?links?\b/iu);
      forbid(sources, 'a link write', /\blinkSource\b|\blinkKind\b/u);
      forbid(sources, 'a catalog or product assignment', /\b(?:catalog|product|variant|assign\w*)\b/iu);
      forbid(sources, 'a domain event or outbox', /\baddDomainEvent\b|\baddOutboxMessage\b|\boutbox\b/iu);
      expect(codeOf(yield* source('media/repository.ts'))).not.toMatch(/\bmediaLinks\b/u);
    }),
  );

  suite.effect('has no product size cap, MIME allowlist, scanner or invented timeout or retry', () =>
    Effect.gen(function* noInventedRules() {
      const sources = yield* loadUploadSources;
      forbid(sources, 'a size cap', /\b(?:maxBytes|maxSize|maxFileSize|sizeLimit|MAX_BYTES|MAX_SIZE)\b/u);
      forbid(sources, 'a MIME allowlist', /\b(?:allowlist|allowedMime|allowedTypes|whitelist|ALLOWED_MIME)\w*/iu);
      forbid(sources, 'a scanner', /\b(?:scanner|malware|antivirus|virus)\b/iu);
      forbid(sources, 'a timeout or retry', /\b(?:timeout|retry|Schedule|attempts|interval)\b/iu);
    }),
  );

  suite.effect('never produces the scanning status: the actions only ever move to ready or failed', () =>
    Effect.gen(function* noScanning() {
      const sources = new Map(yield* loadUploadSources);
      const confirm = sources.get('modules/actions/confirm-asset.action.ts') ?? '';
      expect(sources.get('modules/actions/upload-asset.action.ts')).not.toMatch(/['"]scanning['"]/u);
      expect(confirm).not.toMatch(/['"]scanning['"]/u);
      expect(confirm).toMatch(/to: 'ready'/u);
      expect(confirm).toMatch(/to: 'failed'/u);
    }),
  );

  suite.effect('never names the provider version pin a revision', () =>
    Effect.gen(function* noRevisionNaming() {
      for (const [file, code] of yield* loadUploadSources) {
        for (const line of code
          .split('\n')
          .filter((candidate) => /versionRef|storageObjectVersionRef/u.test(candidate))) {
          expect(line, `${file}: ${line}`).not.toMatch(/revision/iu);
        }
      }
    }),
  );
});

it('exposes no storage location, provider or key in either Action payload or result', () => {
  for (const registration of [uploadAssetAction, confirmAssetAction]) {
    for (const schema of [registration.descriptor.payloadSchema, registration.descriptor.resultSchema]) {
      const fields = Object.keys(schema.fields);
      for (const forbidden of [
        'storageKey',
        'storageProvider',
        'storageObjectVersionRef',
        'url',
        'signedUrl',
        'locator',
      ]) {
        expect(fields).not.toContain(forbidden);
      }
    }
  }
});

it('adds exactly two Core Media entrypoints: no read, no delete, no link, no rename and no integrity Action here', () => {
  const mediaActions = coreActionCatalog.filter(({ owningModuleKey }) => owningModuleKey === 'core.media');
  expect(mediaActions.map(({ actionKey }) => actionKey).toSorted()).toEqual([
    'core.media.confirm-asset',
    'core.media.upload-asset',
  ]);
});
