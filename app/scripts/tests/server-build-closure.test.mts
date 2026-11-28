import { execFileSync } from 'node:child_process';
import {
  mkdtempSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { NodeServices } from '@effect/platform-node';
import { Effect } from 'effect';
import { expect, it } from 'effect-rstest';
import { ChildProcess } from 'effect/process';

import { collectToolingProcess } from './tooling-process-fixture.mts';

const projectConfig = 'tsconfig.json';
const fixtureCompiler = 'compile-fixture.mjs';

const workspace = fileURLToPath(new URL('../..', import.meta.url));
const require = createRequire(import.meta.url);
const frameworkRequire = createRequire(require.resolve('@modern-js/app-tools'));
const serverUtils = path.resolve(path.dirname(frameworkRequire.resolve('@modern-js/server-utils')), '../..');

const compileFixture = `
  import { nativeServerCompiler } from '@modern-js/app-tools-extensions/native-server-compiler';
  import path from 'node:path';
  import { pathToFileURL } from 'node:url';
  const [directory, compiler, expectedValue] = process.argv.slice(2);
  const { compile } = await import(pathToFileURL(compiler).href);
  await compile(directory, { disableTsChecker: true, sourceMap: { js: false } }, {
    compiler: nativeServerCompiler,
    sourceDirs: ['api', 'shared', 'server'].map(name => path.join(directory, name)),
    distDir: path.join(directory, 'dist'),
    tsconfigPath: path.join(directory, 'tsconfig.json'),
    moduleType: 'commonjs',
    throwErrorInsteadOfExit: true,
  });
  const { value } = await import(pathToFileURL(path.join(directory, 'dist/api/index.js')).href);
  if (value !== Number(expectedValue)) throw new Error('The emitted transitive closure does not execute');
  const { schemaVersion } = await import(pathToFileURL(path.join(directory, 'dist/server/modern.server.js')).href);
  if (schemaVersion !== 1) throw new Error('The emitted server root does not execute');
`;

for (const [format, extension] of [
  ['cjs', 'js'],
  ['esm-node', 'mjs'],
] as const) {
  const proveClosure = Effect.fn(function* closureProof() {
    // The compiler resolves imports to physical paths; compare like roots on macOS (/var -> /private/var) and Linux.
    const directory = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'ontos-server-closure-')));
    try {
      const write = (name: string, content: string) => {
        const file = path.join(directory, name);
        mkdirSync(path.dirname(file), { recursive: true });
        writeFileSync(file, content);
      };
      symlinkSync(path.join(workspace, 'node_modules'), path.join(directory, 'node_modules'), 'dir');
      write('package.json', JSON.stringify({ name: 'server-closure-proof', private: true, type: 'commonjs' }));
      write(
        projectConfig,
        JSON.stringify({
          compilerOptions: {
            declaration: true,
            incremental: true,
            module: 'preserve',
            moduleResolution: 'bundler',
            strict: true,
            target: 'esnext',
            tsBuildInfoFile: './original.tsbuildinfo',
            types: [],
          },
          include: ['api', 'shared', 'server'],
          references: [{ path: './dependency' }],
        }),
      );
      write('dependency/tsconfig.json', JSON.stringify({ compilerOptions: { composite: true }, files: ['index.ts'] }));
      write('dependency/index.ts', 'export const dependency = 1;');
      write('api/index.ts', "export { value } from '../src/level-0.js';");
      for (let depth = 0; depth < 6; depth += 1) {
        write(
          `src/level-${depth}.ts`,
          depth === 5
            ? 'export const value = 42; export const invalid: string = 42;'
            : `export { value } from './level-${depth + 1}.js';`,
        );
      }
      write('shared/schema.ts', 'export const schemaVersion = 1;');
      write('server/modern.server.ts', "export { schemaVersion } from '../shared/schema.js';");
      write(fixtureCompiler, compileFixture);
      const authoredConfig = readFileSync(path.join(directory, projectConfig), 'utf-8');
      execFileSync(
        process.execPath,
        [
          path.join(directory, fixtureCompiler),
          directory,
          path.join(serverUtils, `dist/${format}/index.${extension}`),
          '42',
        ],
        {
          cwd: workspace,
          encoding: 'utf-8',
          env: { NO_COLOR: '1' },
          timeout: 30_000,
        },
      );
      expect(readFileSync(path.join(directory, 'dist/src/level-5.js'), 'utf-8')).toContain('42');
      expect(readFileSync(path.join(directory, projectConfig), 'utf-8')).toBe(authoredConfig);
      const emitted = readdirSync(path.join(directory, 'dist'), { recursive: true, withFileTypes: true });
      expect(emitted.filter((file) => file.name.endsWith('.map'))).toEqual([]);
      expect(readFileSync(path.join(directory, 'dist/api/index.d.ts'), 'utf-8')).toContain('value');
      expect(readFileSync(path.join(directory, 'dist/src/level-5.d.ts'), 'utf-8')).toContain('42');
      expect(readFileSync(path.join(directory, 'dist/src/level-5.d.ts'), 'utf-8')).toContain('invalid: string');
      expect(readFileSync(path.join(directory, 'dist/server/modern.server.d.ts'), 'utf-8')).toContain('schemaVersion');
      write('src/level-5.ts', "export { value } from './new-source.js';");
      write('src/new-source.ts', 'export const value = 43; export const invalid: string = 43;');
      execFileSync(
        process.execPath,
        [
          path.join(directory, fixtureCompiler),
          directory,
          path.join(serverUtils, `dist/${format}/index.${extension}`),
          '43',
        ],
        {
          cwd: workspace,
          encoding: 'utf-8',
          env: { NO_COLOR: '1' },
          timeout: 30_000,
        },
      );
      expect(readFileSync(path.join(directory, 'dist/src/new-source.js'), 'utf-8')).toContain('43');
      expect(readFileSync(path.join(directory, 'dist/src/new-source.d.ts'), 'utf-8')).toContain('43');
      expect(readFileSync(path.join(directory, 'dist/src/new-source.d.ts'), 'utf-8')).toContain('invalid: string');
      expect(readFileSync(path.join(directory, projectConfig), 'utf-8')).toBe(authoredConfig);
      expect(
        readdirSync(path.join(directory, 'dist'), { recursive: true, withFileTypes: true }).filter((file) =>
          file.name.endsWith('.map'),
        ),
      ).toEqual([]);
      const checked = yield* collectToolingProcess(
        ChildProcess.make(
          path.join(workspace, 'node_modules/.bin/ultramodern-create'),
          ['ultramodern', 'typecheck', '--project', path.join(directory, projectConfig), '--noEmit'],
          {
            cwd: directory,
            env: { ULTRAMODERN_WORKSPACE_ROOT: directory },
            extendEnv: true,
            stderr: 'pipe',
            stdin: 'ignore',
            stdout: 'pipe',
          },
        ),
      ).pipe(Effect.scoped, Effect.provide(NodeServices.layer), Effect.timeout('30 seconds'));
      expect(checked.status).not.toBe(0);
      expect(checked.stdout).toMatch(/src[/\\]new-source\.ts.*TS2322/u);
    } finally {
      rmSync(directory, { force: true, recursive: true });
    }
  });
  it.live(
    `emits and rebuilds an executable six-deep server closure with declarations and no maps (${format}), while the independent checker rejects bad types`,
    proveClosure,
  );
}
