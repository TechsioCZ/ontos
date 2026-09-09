import { NodeServices } from '@effect/platform-node';
import { Effect, FileSystem, Path, Schema } from 'effect';
import { expect, it } from 'effect-rstest';

import { containsOnlyImportBindings, importCloneEvidence } from '../../quality-audit/import-clone-evidence.mts';

it.effect(
  'recognizes complete static bindings while retaining side effects, implementations and incomplete spans',
  () =>
    Effect.sync(() => {
      const bindings = "import { alpha } from './alpha';\nimport { beta } from './beta';";
      expect(containsOnlyImportBindings(bindings)).toBe(true);
      for (const source of [
        `${bindings}\nalpha(beta);`,
        `${bindings}\nimport './initialize';`,
        `${bindings}\nconst operation = () => alpha(beta);`,
        `/* ${bindings} */`,
        `const text = ${JSON.stringify(bindings)};`,
        `${bindings}\nimport {`,
      ]) {
        expect(containsOnlyImportBindings(source)).toBe(false);
      }
    }),
);

it.live('requires both reported file ranges to prove import bindings', () =>
  Effect.gen(function* importRanges() {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    return yield* Effect.acquireUseRelease(
      fs.makeTempDirectory({ prefix: 'ontos-import-clones-' }),
      (root) =>
        Effect.gen(function* verifyImportRanges() {
          const first = path.join(root, 'first.ts');
          const second = path.join(root, 'second.ts');
          const source = "import { alpha } from './alpha';\nimport { beta } from './beta';\nalpha(beta);";
          yield* fs.writeFileString(first, source);
          yield* fs.writeFileString(second, source);
          const firstFile = { end: 2, name: first, start: 1 };
          const secondFile = { end: 2, name: second, start: 1 };
          const duplicates = [
            { firstFile, secondFile },
            { firstFile, secondFile: { ...secondFile, end: 3 } },
            { firstFile, secondFile: { ...secondFile, end: 99 } },
            { firstFile, secondFile: { name: second, start: 1 } },
            {
              firstFile,
              secondFile: {
                ...secondFile,
                name: path.join(root, '..', 'outside.ts'),
              },
            },
          ];
          const report = yield* Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown))({
            duplicates,
          });
          expect(yield* importCloneEvidence(root, report)).toEqual([{ firstFile, secondFile }]);
        }),
      (root) => fs.remove(root, { recursive: true }),
    );
  }).pipe(Effect.provide(NodeServices.layer)),
);
