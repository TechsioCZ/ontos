import { NodeServices } from '@effect/platform-node';
import { Effect, FileSystem, Path, Schema } from 'effect';
import { ChildProcess, ChildProcessSpawner } from 'effect/unstable/process';
import { expect, layer } from 'effect-rstest';

const CorePackageSchema = Schema.fromJsonString(
  Schema.Struct({
    imports: Schema.Struct({ '#unit-service-fetch': Schema.Record(Schema.String, Schema.String) }),
  }),
);

layer(NodeServices.layer)('unit transport conditional contract', (testing) => {
  testing.effect(
    'keeps a types-only declaration branch and no browser runtime fallback',
    Effect.fn(function* declaredConditions() {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const file = yield* path.fromFileUrl(new URL('../../package.json', import.meta.url));
      const corePackage = yield* fs.readFileString(file).pipe(Effect.flatMap(Schema.decodeEffect(CorePackageSchema)));
      const conditions = corePackage.imports['#unit-service-fetch'];
      expect(Object.keys(conditions)).toEqual(['types', 'workerd', 'node']);
      expect(conditions['types']).toBe('./src/http/unit-service-fetch.ts');
      expect(Object.hasOwn(conditions, 'default')).toBe(false);
      expect(Object.hasOwn(conditions, 'browser')).toBe(false);
    }),
  );

  testing.effect(
    'Node and workerd processes resolve their implementations and unknown transports fail closed',
    Effect.fn(function* runtimeConditions() {
      const path = yield* Path.Path;
      const root = yield* path.fromFileUrl(new URL('../..', import.meta.url));
      const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
      const resolve = (conditions: readonly string[], specifier: string) =>
        ChildProcess.make(
          process.execPath,
          [
            ...conditions.map((condition) => `--conditions=${condition}`),
            '--input-type=module',
            '--eval',
            `console.log(import.meta.resolve('${specifier}'))`,
          ],
          { cwd: root, stderr: 'pipe' },
        );
      const node = yield* spawner.string(resolve([], '#unit-service-fetch'));
      const worker = yield* spawner.string(resolve(['workerd'], '#unit-service-fetch'));
      expect(node.trim()).toBe(new URL('../../src/http/unit-service-fetch.node.ts', import.meta.url).href);
      expect(worker.trim()).toBe(new URL('../../src/http/unit-service-fetch.workerd.ts', import.meta.url).href);
      const invalid = yield* spawner.exitCode(resolve([], '#unit-service-fetch-unknown'));
      expect(invalid).not.toBe(ChildProcessSpawner.ExitCode(0));
    }),
  );
});
