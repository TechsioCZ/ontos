import { NodeServices } from '@effect/platform-node';
import { Effect, FileSystem, Path } from 'effect';
import { expect, it } from 'effect-rstest';

import { walkSourceFiles } from '../check-ontos-module-contracts.mts';

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
});
