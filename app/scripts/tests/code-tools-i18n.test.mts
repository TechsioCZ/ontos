/// <reference types="node" />

import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import test from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { NodeServices } from '@effect/platform-node';
import { Effect, FileSystem, Layer, Path, Schema, Stream } from 'effect';
import { ChildProcess, ChildProcessSpawner } from 'effect/unstable/process';
import { makeEffectTestCallback } from '../../packages/core-runtime/src/testing/effect-runtime.ts';

const encodeJson = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));

const codeToolsPackage = '@modern-js/code-tools';
const malformedPluginCase = 'malformed plugin';
const packageRoot = fileURLToPath(new URL('../..', import.meta.resolve(codeToolsPackage)));
const packageRequire = createRequire(import.meta.resolve(codeToolsPackage));

const cases = [
  {
    diagnostic: null,
    name: 'clean locale branch',
    source: 'export const select = locale => locale === "cs" ? "page" : "undefined";',
  },
  {
    diagnostic: /no-literal-visible-jsx-attributes/u,
    name: 'literal visible attribute',
    source: 'export const View = () => <input placeholder="Visible copy" />;',
  },
  {
    diagnostic: /no-manual-locale-copy-branching/u,
    name: 'locale copy branch',
    source: 'export const select = locale => locale === "cs" ? "Český text" : "English copy";',
  },
  {
    diagnostic: /deliberate-i18n-plugin-failure/u,
    name: malformedPluginCase,
    source: 'export const value = 1;',
  },
];

for (const format of ['cjs', 'esm', 'esm-node']) {
  for (const fixture of cases) {
    const testEffect = Effect.gen(function* verifyI18nAdapter() {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const oxlintRoot = path.dirname(packageRequire.resolve('oxlint/package.json'));
      const root = yield* fs.makeTempDirectoryScoped({ prefix: 'ontos-code-tools-i18n-' });
      const extension = format === 'cjs' ? 'cjs' : 'js';
      const dist = path.join(root, 'dist', format);
      yield* fs.makeDirectory(path.join(root, 'dist'), { recursive: true });
      yield* fs.copy(path.join(packageRoot, 'dist', format), dist);
      yield* fs.writeFileString(
        path.join(root, 'package.json'),
        encodeJson({ name: codeToolsPackage, type: 'module' }),
      );
      yield* fs.makeDirectory(path.join(root, 'node_modules'));
      yield* fs.symlink(oxlintRoot, path.join(root, 'node_modules', 'oxlint'));
      yield* fs.makeDirectory(path.join(root, 'src'));
      yield* fs.writeFileString(path.join(root, 'src', 'fixture.tsx'), fixture.source);
      if (fixture.name === malformedPluginCase) {
        // A deliberately broken, isolated plugin exercises Oxlint's actual crash reporter.
        const plugin =
          '{ meta: { name: "ultramodern" }, rules: { "no-manual-locale-copy-branching": { meta: { schema: [] }, create() { return { Program() { throw new Error("deliberate-i18n-plugin-failure"); } }; } } } }';
        yield* fs.writeFileString(
          path.join(root, 'src', 'oxlint-plugin.ts'),
          `export default ${plugin};`,
        );
      } else if (format === 'cjs') {
        // Oxlint expects the plugin value, not the CJS module's named-export namespace.
        yield* fs.writeFileString(
          path.join(root, 'src', 'oxlint-plugin.ts'),
          'import plugin from "../dist/cjs/oxlint-plugin.cjs"; export default plugin.default;',
        );
      }
      const adapter = pathToFileURL(path.join(dist, 'cli', `oxlint.${extension}`)).href;
      const rules =
        fixture.name === malformedPluginCase
          ? { 'ultramodern/no-manual-locale-copy-branching': 'error' }
          : {
              'ultramodern/no-literal-visible-jsx-attributes': 'error',
              'ultramodern/no-manual-locale-copy-branching': 'error',
            };
      const script = `import { runOxlintRules, printOxlintOutput } from ${encodeJson(adapter)};
const result = runOxlintRules({ cwd: ${encodeJson(root)}, targets: ['src'], rules: ${encodeJson(rules)} });
printOxlintOutput(result); process.exitCode = result.exitCode;`;
      const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
      const child = yield* spawner.spawn(
        ChildProcess.make(process.execPath, ['--input-type=module', '--eval', script], {
          cwd: root,
          env: { TMPDIR: root },
          extendEnv: true,
          stderr: 'pipe',
          stdin: 'ignore',
          stdout: 'pipe',
        }),
      );
      const result = yield* Effect.all(
        {
          status: child.exitCode.pipe(Effect.map(Number)),
          stderr: child.stderr.pipe(Stream.decodeText(), Stream.mkString),
          stdout: child.stdout.pipe(Stream.decodeText(), Stream.mkString),
        },
        { concurrency: 'unbounded' },
      );
      const output = result.stdout + result.stderr;
      if (fixture.diagnostic === null) {
        assert.equal(result.status, 0, output);
        assert.equal(output, '');
      } else {
        assert.equal(result.status, 1, output);
        assert.match(output, fixture.diagnostic);
        assert.match(output, /fixture\.tsx/u);
        if (fixture.name === malformedPluginCase) {
          assert.match(output, /Error running JS plugin/u);
          assert.doesNotMatch(output, /:0:0: {2}\[Warning\]/u);
        } else {
          assert.match(output, /fixture\.tsx:1:\d+/u);
          assert.doesNotMatch(output, /Error running JS plugin/u);
        }
      }
    });
    void test(
      `code-tools ${format}: ${fixture.name}`,
      makeEffectTestCallback(
        Effect.scoped(
          Layer.build(Layer.effectDiscard(testEffect).pipe(Layer.provide(NodeServices.layer))),
        ),
      ),
    );
  }
}
