import { NodeServices } from '@effect/platform-node';
import { Effect, FileSystem, Path } from 'effect';
import { expect, it } from 'effect-rstest';

import { checkSharedSourceFile, walkSourceFiles } from '../check-ontos-module-contracts.mts';

/*
 * The module-contract gate reads a module's own sources. Gitignored build output is not source: a compiled bundle
 * repeats the text of what it was built from and would fail the gate on a machine that had built the module.
 */

it.layer(NodeServices.layer)('module contract source walk', (suite) => {
  suite.effect('reads sources and skips installed dependencies and build output', () =>
    Effect.gen(function* walk() {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fileSystem.makeTempDirectoryScoped();
      const files = ['src/owned.ts', 'node_modules/a/index.js', 'dist/b.js', '.output/server/c.mjs'];
      for (const file of files) {
        const target = path.join(root, file);
        yield* fileSystem.makeDirectory(path.dirname(target), { recursive: true });
        yield* fileSystem.writeFileString(target, 'registerSystemWorkload');
      }
      expect(yield* walkSourceFiles(root)).toEqual([path.join(root, 'src/owned.ts')]);
    }),
  );

  suite.effect('rejects a shared source that imports a private deployment file or private vertical source', () =>
    Effect.gen(function* sharedImports() {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const target = path.join(yield* fileSystem.makeTempDirectoryScoped(), 'shared.ts');
      const outcome = (source: string) =>
        fileSystem
          .writeFileString(target, source)
          .pipe(
            Effect.andThen(checkSharedSourceFile(fileSystem, target)),
            Effect.match({ onFailure: ({ message }) => message, onSuccess: () => 'accepted' }),
          );
      const privateSource = 'imports production vertical private source';
      const privateDeployment = 'imports a private deployment manifest or registration';

      expect(yield* outcome("import { a } from '@app/pricing-contracts';\n")).toBe('accepted');
      expect(yield* outcome("import { a } from '@app/core-runtime/src/modules/manifest.ts';\n")).toBe('accepted');
      expect(yield* outcome("import { a } from '@app/pricing/sources';\n")).toBe('accepted');
      expect(yield* outcome("import { a } from '@app/pricing/src/domain.ts';\n")).toContain(privateSource);
      expect(yield* outcome("export * from\n  '../../verticals/pricing/db';\n")).toContain(privateSource);
      expect(yield* outcome("const owner = await import('@app/tax/vertical.registration/parts');\n")).toContain(
        privateSource,
      );
      expect(yield* outcome("const owner = await import('@app/tax/vertical.registration');\n")).toContain(
        privateDeployment,
      );
      expect(yield* outcome("const owner = require('../vertical.manifest.ts');\n")).toContain(privateDeployment);
      expect(yield* outcome("import { a } from './vertical.runtime-declaration';\n")).toContain(privateDeployment);
    }),
  );
});
