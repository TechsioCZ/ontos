import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { expect, it } from 'effect-rstest';

const workspace = fileURLToPath(new URL('../..', import.meta.url));
const require = createRequire(import.meta.url);
const frameworkRequire = createRequire(require.resolve('@modern-js/app-tools'));
const serverUtils = path.resolve(path.dirname(frameworkRequire.resolve('@modern-js/server-utils')), '../..');

const compileFixture = `
  import { readFileSync } from 'node:fs';
  import path from 'node:path';
  import { pathToFileURL } from 'node:url';
  const [directory, compiler, expectedValue] = process.argv.slice(1);
  const { compile } = await import(pathToFileURL(compiler).href);
  await compile(directory, {}, {
    sourceDirs: ['api', 'shared', 'server'].map(name => path.join(directory, name)),
    distDir: path.join(directory, 'dist'),
    tsconfigPath: path.join(directory, 'tsconfig.json'),
    moduleType: 'commonjs',
    throwErrorInsteadOfExit: true,
  });
  const { value } = await import(pathToFileURL(path.join(directory, 'dist/api/index.js')).href);
  if (value !== Number(expectedValue)) throw new Error('The emitted transitive closure does not execute');
  const config = JSON.parse(readFileSync(path.join(directory, 'tsconfig.json'), 'utf-8'));
  if (!config.references?.length || !config.compilerOptions.incremental)
    throw new Error('The authored project graph was changed');
`;

for (const [format, extension] of [
  ['cjs', 'js'],
  ['esm-node', 'mjs'],
] as const) {
  it(`emits a six-deep server closure once (${format}), while the independent checker still rejects bad types`, () => {
    const directory = mkdtempSync(path.join(os.tmpdir(), 'ontos-server-closure-'));
    try {
      const write = (name: string, content: string) => {
        const file = path.join(directory, name);
        mkdirSync(path.dirname(file), { recursive: true });
        writeFileSync(file, content);
      };
      symlinkSync(path.join(workspace, 'node_modules'), path.join(directory, 'node_modules'), 'dir');
      write('package.json', JSON.stringify({ name: 'server-closure-proof', private: true, type: 'commonjs' }));
      write(
        'tsconfig.json',
        JSON.stringify({
          compilerOptions: {
            declaration: true,
            incremental: true,
            module: 'preserve',
            moduleResolution: 'bundler',
            strict: true,
            target: 'esnext',
            tsBuildInfoFile: './original.tsbuildinfo',
          },
          include: ['api', 'shared', 'server'],
          references: [{ path: './dependency' }],
        }),
      );
      write('dependency/tsconfig.json', JSON.stringify({ compilerOptions: { composite: true }, files: ['index.ts'] }));
      write('dependency/index.ts', 'export const dependency = 1;');
      write('api/index.ts', "export { value } from '../src/level-0.js';");
      write('api/invalid.ts', 'export const invalid: string = 42;');
      for (let depth = 0; depth < 6; depth += 1) {
        write(
          `src/level-${depth}.ts`,
          depth === 5 ? 'export const value = 42;' : `export { value } from './level-${depth + 1}.js';`,
        );
      }
      write('shared/schema.ts', 'export const schemaVersion = 1;');
      write('server/modern.server.ts', "export { schemaVersion } from '../shared/schema.js';");
      const output = execFileSync(
        process.execPath,
        [
          '--input-type=module',
          '-e',
          compileFixture,
          directory,
          path.join(serverUtils, `dist/${format}/index.${extension}`),
          '42',
        ],
        {
          cwd: workspace,
          encoding: 'utf-8',
          env: { NO_COLOR: '1', ONTOS_CI_TYPECHECK_SEPARATE: '1' },
          timeout: 30_000,
        },
      );
      expect(output.match(/build started/gu)).toHaveLength(1);
      expect(readFileSync(path.join(directory, 'dist/src/level-5.js'), 'utf-8')).toContain('42');
      const emitted = readdirSync(path.join(directory, 'dist'), { recursive: true, withFileTypes: true });
      expect(emitted.filter((file) => /\.(?:map|d\.ts)$/u.test(file.name))).toEqual([]);
      write('src/level-5.ts', "export { value } from './new-source.js';");
      write('src/new-source.ts', 'export const value = 43;');
      const changed = execFileSync(
        process.execPath,
        [
          '--input-type=module',
          '-e',
          compileFixture,
          directory,
          path.join(serverUtils, `dist/${format}/index.${extension}`),
          '43',
        ],
        {
          cwd: workspace,
          encoding: 'utf-8',
          env: { NO_COLOR: '1', ONTOS_CI_TYPECHECK_SEPARATE: '1' },
          timeout: 30_000,
        },
      );
      expect(changed.match(/build started/gu)).toHaveLength(1);
      const checked = spawnSync(
        process.execPath,
        [
          path.join(path.dirname(require.resolve('typescript/package.json')), 'bin/tsc'),
          '-p',
          path.join(directory, 'tsconfig.json'),
          '--noEmit',
        ],
        { cwd: workspace, encoding: 'utf-8' },
      );
      expect(checked.status).not.toBe(0);
      expect(checked.stdout).toContain('TS2322');
    } finally {
      rmSync(directory, { force: true, recursive: true });
    }
  });
}
