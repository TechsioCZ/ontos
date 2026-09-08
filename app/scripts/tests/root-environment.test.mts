import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const appRoot = path.resolve(import.meta.dirname, '../..');
const repositoryRoot = path.dirname(appRoot);
const expectedEnvironmentPath = path.join(appRoot, '.env');

void test('apps contain no environment files that can override the app-root .env', () => {
  const result = spawnSync(
    '/usr/bin/find',
    [
      path.join(appRoot, 'apps'),
      '-type',
      'f',
      '-name',
      '.env*',
      '-not',
      '-path',
      '*/node_modules/*',
    ],
    { encoding: 'utf-8' },
  );

  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout.trim(), '');
});

void test('workspace discovery resolves repository, app, shell, and microvertical directories', async () => {
  const { resolveAppWorkspaceRoot } =
    await import('../../packages/core-runtime/src/environment/workspace-environment.ts');

  for (const directory of [
    repositoryRoot,
    appRoot,
    path.join(appRoot, 'apps/shell-super-app'),
    path.join(appRoot, 'verticals/party-registry'),
  ]) {
    assert.equal(resolveAppWorkspaceRoot(directory), appRoot);
  }
});

void test('all server configuration resolves the app-root .env from any invocation directory', () => {
  const probe = new URL('server-environment-paths.fixture.mts', import.meta.url);
  const child = spawnSync(
    '/usr/bin/env',
    [
      '-u',
      'ULTRAMODERN_WORKSPACE_ROOT',
      `INIT_CWD=${repositoryRoot}`,
      process.execPath,
      fileURLToPath(probe),
    ],
    {
      cwd: '/',
      encoding: 'utf-8',
    },
  );

  assert.equal(child.status, 0, child.stderr);
  assert.deepEqual(JSON.parse(child.stdout.trim()), [
    expectedEnvironmentPath,
    expectedEnvironmentPath,
    expectedEnvironmentPath,
  ]);
});

void test('Drizzle configuration remains bundleable as CommonJS', () => {
  const outputDirectory = mkdtempSync(path.join(tmpdir(), 'ontos-drizzle-cjs-'));
  try {
    const result = spawnSync(
      path.join(appRoot, 'node_modules/.bin/esbuild'),
      [
        path.join(appRoot, 'packages/core-runtime/drizzle.config.ts'),
        '--bundle',
        '--format=cjs',
        '--packages=external',
        '--platform=node',
        `--outfile=${path.join(outputDirectory, 'drizzle.config.cjs')}`,
      ],
      { encoding: 'utf-8' },
    );
    assert.equal(result.status, 0, result.stderr);
  } finally {
    rmSync(outputDirectory, { force: true, recursive: true });
  }
});
