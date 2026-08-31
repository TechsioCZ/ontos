/* eslint-disable node/no-process-env -- The subprocess verifies hostile invocation environments. */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import test from 'node:test';
import { pathToFileURL } from 'node:url';

const appRoot = path.resolve(import.meta.dirname, '../../../..');
const repositoryRoot = path.dirname(appRoot);
const expectedEnvironmentPath = path.join(appRoot, '.env');
const exampleEnvironmentPath = path.join(appRoot, '.env.example');

test('apps contain no environment files that can override the app-root .env', () => {
  const result = spawnSync(
    'find',
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
    await import('../../src/environment/workspace-environment.ts');

  for (const directory of [
    repositoryRoot,
    appRoot,
    path.join(appRoot, 'apps/shell-super-app'),
    path.join(appRoot, 'verticals/projects'),
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

test('the documented local environment preserves JSON gateway keys when sourced by a shell', () => {
  const validationSource = `
    JSON.parse(process.env.ONTOS_GATEWAY_PRIVATE_JWK);
    JSON.parse(process.env.ONTOS_GATEWAY_PUBLIC_JWKS);
  `;
  const child = spawnSync(
    '/bin/sh',
    [
      '-c',
      'set -a; . "$1"; set +a; exec "$2" --eval "$3"',
      'environment-check',
      exampleEnvironmentPath,
      process.execPath,
      validationSource,
    ],
    { encoding: 'utf-8' },
  );

  assert.equal(child.status, 0, child.stderr);
});
