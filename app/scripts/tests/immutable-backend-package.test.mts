import { Effect, Schema } from 'effect';
import { expect, it } from 'effect-rstest';

import {
  ImmutableBackendPackageError,
  immutableBackendModuleInventorySha256,
  verifyImmutableBackendModuleContent,
} from '../immutable-backend-package.mts';

const module = (path: string, text: string) => ({ bytes: new TextEncoder().encode(text), path });
const mainModule = module('index.mjs', 'export default {}');
const dataModule = module('assets/data.bin', 'exact module bytes');
const expected = [mainModule, dataModule];
const reversed = [dataModule, mainModule];
const contentFor = (modules = expected) => {
  const content = new FormData();
  content.append('metadata', JSON.stringify({ main_module: 'index.mjs' }));
  for (const item of modules) {
    content.append(item.path, new Blob([item.bytes]), item.path);
  }
  return content;
};

it.effect('verifies the complete native upload inventory independently of multipart ordering', () =>
  Effect.gen(function* verifiesCompleteInventory() {
    const digest = yield* verifyImmutableBackendModuleContent(expected, contentFor(reversed));
    expect(digest).toBe(yield* immutableBackendModuleInventorySha256(expected));
    expect(digest).toBe(yield* immutableBackendModuleInventorySha256(reversed));
  }),
);

it.effect('rejects changed, missing and extra provider modules', () =>
  Effect.gen(function* rejectsUnexpectedInventory() {
    for (const modules of [
      [module('index.mjs', 'export default { changed: true }'), dataModule],
      [mainModule],
      [...expected, module('unapproved.mjs', 'export const surprise = true')],
    ]) {
      const error = yield* verifyImmutableBackendModuleContent(expected, contentFor(modules)).pipe(Effect.flip);
      expect(Schema.is(ImmutableBackendPackageError)(error)).toBe(true);
    }
  }),
);

it.effect('rejects duplicate multipart modules and metadata disguised as a file', () =>
  Effect.gen(function* rejectsMultipartDuplicates() {
    const duplicate = contentFor();
    duplicate.append('index.mjs', new Blob([mainModule.bytes]), 'index.mjs');
    const duplicateError = yield* verifyImmutableBackendModuleContent(expected, duplicate).pipe(Effect.flip);
    expect(Schema.is(ImmutableBackendPackageError)(duplicateError)).toBe(true);
    const metadataFile = contentFor();
    metadataFile.set('metadata', new Blob(['{}']), 'metadata');
    const metadataError = yield* verifyImmutableBackendModuleContent(expected, metadataFile).pipe(Effect.flip);
    expect(Schema.is(ImmutableBackendPackageError)(metadataError)).toBe(true);
  }),
);

it.effect('rejects ambiguous expected inventories and mismatched native filenames', () =>
  Effect.gen(function* rejectsAmbiguousInventories() {
    for (const modules of [[], [mainModule, mainModule], [module('../outside.mjs', 'outside')]]) {
      const error = yield* verifyImmutableBackendModuleContent(modules, contentFor()).pipe(Effect.flip);
      expect(Schema.is(ImmutableBackendPackageError)(error)).toBe(true);
    }
    const content = contentFor();
    content.set('index.mjs', new Blob([mainModule.bytes]), 'different.mjs');
    const filenameError = yield* verifyImmutableBackendModuleContent(expected, content).pipe(Effect.flip);
    expect(Schema.is(ImmutableBackendPackageError)(filenameError)).toBe(true);
  }),
);
