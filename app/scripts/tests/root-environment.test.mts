import { expect, it } from '@app/effect-rstest';
import { Effect } from 'effect';

import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { pathToFileURL } from 'node:url';

const appRoot = path.resolve(import.meta.dirname, '../..');
const repositoryRoot = path.dirname(appRoot);
const expectedEnvironmentPath = path.join(appRoot, '.env');

it('apps contain no environment files that can override the app-root .env', () => {
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

  expect(result.status, result.stderr).toBe(0);
  expect(result.stdout.trim()).toBe('');
});

it.live(
  'workspace discovery resolves repository, app, shell, and microvertical directories',
  Effect.fn(function* testEffect1() {
    const { resolveAppWorkspaceRoot } = yield* Effect.tryPromise(
      () => import('../../packages/core-runtime/src/environment/workspace-environment.ts'),
    );

    for (const directory of [
      repositoryRoot,
      appRoot,
      path.join(appRoot, 'apps/shell-super-app'),
      path.join(appRoot, 'verticals/party-registry'),
    ]) {
      expect(resolveAppWorkspaceRoot(directory)).toBe(appRoot);
    }
  }),
);

it('all server configuration resolves the app-root .env from any invocation directory', () => {
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
  const child = spawnSync(
    '/usr/bin/env',
    [
      '-u',
      'ULTRAMODERN_WORKSPACE_ROOT',
      `INIT_CWD=${repositoryRoot}`,
      process.execPath,
      '--input-type=module',
      '--eval',
      source,
    ],
    {
      cwd: '/',
      encoding: 'utf-8',
    },
  );

  expect(child.status, child.stderr).toBe(0);
  expect(JSON.parse(child.stdout.trim())).toEqual([
    expectedEnvironmentPath,
    expectedEnvironmentPath,
    expectedEnvironmentPath,
  ]);
});

it('Drizzle configuration remains bundleable as CommonJS', () => {
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
    expect(result.status, result.stderr).toBe(0);
  } finally {
    rmSync(outputDirectory, { force: true, recursive: true });
  }
});
