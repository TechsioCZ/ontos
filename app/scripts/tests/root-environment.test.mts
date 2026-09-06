import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { pathToFileURL } from 'node:url';

const appRoot = path.resolve(import.meta.dirname, '../..');
const repositoryRoot = path.dirname(appRoot);
const expectedEnvironmentPath = path.join(appRoot, '.env');

test('apps contain no environment files that can override the app-root .env', () => {
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

test('workspace discovery resolves repository, app, shell, and microvertical directories', async () => {
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

test('all server configuration resolves the app-root .env from any invocation directory', () => {
  const databaseConfigUrl = pathToFileURL(
    path.join(appRoot, 'packages/core-runtime/src/db/config.ts'),
  ).href;
  const permissionConfigUrl = pathToFileURL(
    path.join(appRoot, 'packages/core-runtime/src/permissions/config.ts'),
  ).href;
  const authConfigUrl = pathToFileURL(
    path.join(appRoot, 'apps/shell-super-app/api/auth/config.ts'),
  ).href;
  const source = `
    const database = await import(${JSON.stringify(databaseConfigUrl)});
    const permissions = await import(${JSON.stringify(permissionConfigUrl)});
    const auth = await import(${JSON.stringify(authConfigUrl)});
    console.log(JSON.stringify([
      database.ROOT_ENV_PATH,
      permissions.SPICEDB_ROOT_ENV_PATH,
      auth.ROOT_ENV_PATH,
    ]));
  `;
  const { ULTRAMODERN_WORKSPACE_ROOT: _ignoredWorkspaceRoot, ...environment } = process.env;
  const child = spawnSync(process.execPath, ['--input-type=module', '--eval', source], {
    cwd: '/',
    encoding: 'utf-8',
    env: { ...environment, INIT_CWD: repositoryRoot },
  });

  assert.equal(child.status, 0, child.stderr);
  assert.deepEqual(JSON.parse(child.stdout.trim()), [
    expectedEnvironmentPath,
    expectedEnvironmentPath,
    expectedEnvironmentPath,
  ]);
});

test('Drizzle configuration remains bundleable as CommonJS', () => {
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
