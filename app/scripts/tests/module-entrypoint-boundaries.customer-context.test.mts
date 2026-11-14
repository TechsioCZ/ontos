import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { Effect } from 'effect';
import { expect, it } from 'effect-rstest';
import { hasCompleteGeneratedModuleApiSeam } from '../generated-governed-http-boundary.mts';
import {
  CORE_RUNTIME_SOURCE_IMPORT,
  CUSTOMER_CONTEXT_VERTICAL_PATH,
  readPricingSourceTree,
} from './module-entrypoint-boundaries.fixture.mts';

for (const owner of [CUSTOMER_CONTEXT_VERTICAL_PATH]) {
  it.live(`proves the full native operationContracts array for ${owner}, independent of marker placement`, () =>
    Effect.gen(function* nativeOwnerOperationInventory() {
      const root = path.resolve(import.meta.dirname, '../..');
      const trees = yield* Effect.all(
        [`${owner}/api`, `${owner}/shared`, `${owner}/src`, 'packages'].map((folder) =>
          Effect.promise(() => readPricingSourceTree(root, folder)),
        ),
      );
      const runtimeDeclarationFile = `${owner}/vertical.runtime-declaration.ts`;
      const hasRuntimeDeclaration = yield* Effect.promise(() =>
        readFile(path.join(root, runtimeDeclarationFile), 'utf-8').then(
          () => true,
          () => false,
        ),
      );
      const metadata = yield* Effect.all(
        [
          `${owner}/package.json`,
          `${owner}/vertical.manifest.ts`,
          `${owner}/vertical.registration.ts`,
          ...(hasRuntimeDeclaration ? [runtimeDeclarationFile] : []),
        ].map((file) =>
          Effect.promise(() => readFile(path.join(root, file), 'utf-8')).pipe(
            Effect.map((source) => [file, source] as const),
          ),
        ),
      );
      const sources = new Map([...trees.flat(), ...metadata]);
      const start = '// <generated-module-manifest-operation-contracts>';
      const end = '// </generated-module-manifest-operation-contracts>';
      // A runtime declaration split (as in main's Party Registry) carries the operation contracts instead of the manifest.
      const manifestFile = (sources.get(`${owner}/vertical.manifest.ts`) ?? '').includes(start)
        ? `${owner}/vertical.manifest.ts`
        : runtimeDeclarationFile;
      const manifest = sources.get(manifestFile) ?? '';
      const begin = manifest.indexOf(start);
      const finish = manifest.indexOf(end);
      expect(begin).toBeGreaterThan(0);
      expect(finish).toBeGreaterThan(begin);
      const claims = manifest.slice(begin + start.length, finish);
      const outside = `${manifest.slice(0, begin)}${claims}${start}\n${manifest.slice(finish)}`;
      const deployment = path.posix.basename(owner);
      const diagnostics: string[] = [];
      const accepts = (source: string, sink?: string[]) =>
        hasCompleteGeneratedModuleApiSeam(
          new Map([...sources, [manifestFile, source]]),
          `${owner}/shared/api.ts`,
          deployment,
          sink,
        );
      expect(accepts(manifest, diagnostics), diagnostics.join('\n')).toBe(true);
      expect(accepts(outside)).toBe(true);
      const detached = manifest.slice(0, begin + start.length) + manifest.slice(finish);
      expect(accepts(`${detached}\nconst detachedContracts = [${claims}];`)).toBe(false);
      expect(accepts(outside.replace('operationContracts: [', 'unboundContracts: ['))).toBe(false);
      expect(accepts(outside.replace(/apiKey: '[^']+'/u, "apiKey: 'unpublished-operation'"))).toBe(false);
      expect(accepts(outside.replace('operationContracts: [', 'operationContracts: [{ ...foreignClaim },'))).toBe(
        false,
      );
      expect(accepts(manifest.replaceAll(CORE_RUNTIME_SOURCE_IMPORT, "from './counterfeit-core.ts'"))).toBe(false);
      const runtimeManifestName = `${deployment.replaceAll(/-(?<letter>[a-z])/gu, (_match, letter: string) => letter.toUpperCase())}RuntimeManifest`;
      const duplicateRoot =
        manifestFile === runtimeDeclarationFile
          ? `${manifest}\nexport const ${runtimeManifestName} = { publicSurface: { operationContracts: [] } };`
          : `${manifest}\nexport const detachedManifest = defineOntosModuleManifest({ publicSurface: { operationContracts: [] } });`;
      expect(accepts(duplicateRoot)).toBe(false);
    }),
  );
}
