import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { stripVTControlCharacters } from 'node:util';

import { NodeServices } from '@effect/platform-node';
import { Effect, FileSystem, Path, Schema, Stream } from 'effect';
import { expect, it } from 'effect-rstest';
import { ChildProcess, ChildProcessSpawner } from 'effect/unstable/process';

const encodeJson = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));

const codeToolsPackage = '@modern-js/code-tools';
const malformedPluginCase = 'malformed plugin';
const cleanOutput =
  /^(?:Found 0 warnings and 0 errors\.\r?\nFinished in \d+(?:\.\d+)?(?:ms|s) on [1-9]\d* files? with \d+ rules using [1-9]\d* threads?\.\r?\n)?$/u;
const require = createRequire(import.meta.url);
const packageEntry = pathToFileURL(require.resolve(codeToolsPackage));
const packageRoot = fileURLToPath(new URL('../..', packageEntry));
const packageRequire = createRequire(packageEntry);

const cases = [
  {
    diagnostic: null,
    name: 'clean locale branch',
    source:
      'export const select = locale => locale === "cs" ? "page" : "undefined";',
  },
  {
    diagnostic: /no-literal-visible-jsx-attributes/u,
    name: 'literal visible attribute',
    source: 'export const View = () => <input placeholder="Visible copy" />;',
  },
  {
    diagnostic: /no-manual-locale-copy-branching/u,
    name: 'locale copy branch',
    source:
      'export const select = locale => locale === "cs" ? "Český text" : "English copy";',
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
      const oxlintRoot = path.dirname(
        packageRequire.resolve('oxlint/package.json')
      );
      const root = yield* fs.makeTempDirectoryScoped({
        prefix: 'ontos-code-tools-i18n-',
      });
      const extension = format === 'cjs' ? 'cjs' : 'js';
      const dist = path.join(root, 'dist', format);
      yield* fs.makeDirectory(path.join(root, 'dist'), { recursive: true });
      yield* fs.copy(path.join(packageRoot, 'dist', format), dist);
      yield* fs.writeFileString(
        path.join(root, 'package.json'),
        encodeJson({ name: codeToolsPackage, type: 'module' })
      );
      yield* fs.makeDirectory(path.join(root, 'node_modules'));
      yield* fs.symlink(oxlintRoot, path.join(root, 'node_modules', 'oxlint'));
      yield* fs.makeDirectory(path.join(root, 'node_modules', '@babel'));
      for (const dependency of ['parser', 'traverse', 'types']) {
        yield* fs.symlink(
          path.dirname(
            packageRequire.resolve(`@babel/${dependency}/package.json`)
          ),
          path.join(root, 'node_modules', '@babel', dependency)
        );
      }
      yield* fs.makeDirectory(path.join(root, 'src'));
      yield* fs.writeFileString(
        path.join(root, 'src', 'fixture.tsx'),
        fixture.source
      );
      if (fixture.name === malformedPluginCase) {
        // A deliberately broken, isolated plugin exercises Oxlint's actual crash reporter.
        const plugin =
          '{ meta: { name: "ultramodern" }, rules: { "no-manual-locale-copy-branching": { meta: { schema: [] }, create() { return { Program() { throw new Error("deliberate-i18n-plugin-failure"); } }; } } } }';
        yield* fs.writeFileString(
          path.join(root, 'src', 'oxlint-plugin.ts'),
          `export default ${plugin};`
        );
      } else if (format === 'cjs') {
        // Oxlint expects the plugin value, not the CJS module's named-export namespace.
        yield* fs.writeFileString(
          path.join(root, 'src', 'oxlint-plugin.ts'),
          'import plugin from "../dist/cjs/oxlint-plugin.cjs"; export default plugin.default;'
        );
      }
      const adapter = pathToFileURL(
        path.join(dist, 'cli', `oxlint.${extension}`)
      ).href;
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
        ChildProcess.make(
          process.execPath,
          ['--input-type=module', '--eval', script],
          {
            cwd: root,
            env: { TMPDIR: root },
            extendEnv: true,
            stderr: 'pipe',
            stdin: 'ignore',
            stdout: 'pipe',
          }
        )
      );
      const result = yield* Effect.all(
        {
          status: child.exitCode.pipe(Effect.map(Number)),
          stderr: child.stderr.pipe(Stream.decodeText(), Stream.mkString),
          stdout: child.stdout.pipe(Stream.decodeText(), Stream.mkString),
        },
        { concurrency: 'unbounded' }
      );
      const output = stripVTControlCharacters(result.stdout + result.stderr);
      if (fixture.diagnostic === null) {
        expect(result.status, output).toBe(0);
        expect(output).toMatch(cleanOutput);
      } else {
        expect(result.status, output).toBe(1);
        expect(output).toMatch(fixture.diagnostic);
        expect(output).toMatch(/fixture\.tsx/u);
        if (fixture.name === malformedPluginCase) {
          expect(output).toMatch(/Error running JS plugin/u);
          expect(output).not.toMatch(/:0:0: {2}\[Warning\]/u);
        } else {
          expect(output).toMatch(/fixture\.tsx:1:\d+/u);
          expect(output).not.toMatch(/Error running JS plugin/u);
        }
      }
    });
    it.live(`code-tools ${format}: ${fixture.name}`, () =>
      testEffect.pipe(Effect.provide(NodeServices.layer))
    );
  }
}

it('clean i18n output accepts only silence or a zero-diagnostic summary', () => {
  const summary =
    'Found 0 warnings and 0 errors.\nFinished in 423ms on 2 files with 98 rules using 4 threads.\n';
  expect('').toMatch(cleanOutput);
  expect(summary).toMatch(cleanOutput);
  for (const output of [
    summary.replace('0 errors', '1 error'),
    summary.replace('0 warnings', '1 warning'),
    summary.replace('2 files', '0 files'),
    `${summary}Error running JS plugin\n`,
    `fixture.tsx:1:1: unexpected diagnostic\n${summary}`,
  ]) {
    expect(output).not.toMatch(cleanOutput);
  }
});
