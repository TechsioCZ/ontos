import { readFile } from 'node:fs/promises';
import { expect, test } from '@rstest/core';
import { Effect } from 'effect';
import {
  classifyExactStageDemoRecord,
  parseStageDemoBootstrapConfig,
} from '../../api/auth/stage-demo-bootstrap-contract.ts';

const validEnvironment = {
  BETTER_AUTH_SECRET: 'stage-auth-secret-with-at-least-32-characters',
  BETTER_AUTH_URL: 'https://shell.stage.example.test',
  DATABASE_ADMIN_URL: 'postgresql://db:password@db:5432/db',
  SPICEDB_ENDPOINT: 'spicedb:50051',
  SPICEDB_INSECURE: 'true',
  SPICEDB_PRESHARED_KEY: 'stage-spicedb-key',
  STAGE_DEMO_PASSWORD: 'test-only-bootstrap-password',
  ULTRAMODERN_DEPLOYMENT_ENVIRONMENT: 'stage',
} as const;

test('accepts the complete stage-only demo bootstrap configuration', () => {
  expect(Effect.runSync(parseStageDemoBootstrapConfig(validEnvironment))).toEqual({
    authBaseUrl: 'https://shell.stage.example.test',
    authSecret: 'stage-auth-secret-with-at-least-32-characters',
    databaseAdminUrl: 'postgresql://db:password@db:5432/db',
    password: 'test-only-bootstrap-password',
  });
});

test('refuses to provision outside stage or without an operator-supplied password', () => {
  expect(
    Effect.runSync(
      Effect.flip(
        parseStageDemoBootstrapConfig({
          ...validEnvironment,
          ULTRAMODERN_DEPLOYMENT_ENVIRONMENT: 'production',
        }),
      ),
    ),
  ).toMatchObject({ reason: expect.stringMatching(/stage environment/u) });
  expect(
    Effect.runSync(
      Effect.flip(
        parseStageDemoBootstrapConfig({
          ...validEnvironment,
          STAGE_DEMO_PASSWORD: undefined,
        }),
      ),
    ),
  ).toMatchObject({ reason: expect.stringMatching(/STAGE_DEMO_PASSWORD/u) });
});

test('treats an exact record as idempotent and rejects conflicting state', () => {
  const expected = { name: 'Techsio', slug: 'techsio', status: 'active' } as const;
  expect(classifyExactStageDemoRecord('tenant', undefined, expected)).toBe('create');
  expect(classifyExactStageDemoRecord('tenant', expected, expected)).toBe('existing');
  try {
    classifyExactStageDemoRecord('tenant', { ...expected, name: 'Other tenant' }, expected);
    throw new Error('Expected a stage demo conflict');
  } catch (error) {
    expect(error).toMatchObject({ reason: expect.stringMatching(/conflicts/u) });
  }
});

test('keeps the demo bootstrap operator-invoked and excludes its password from source', async () => {
  const rootPackage = await readFile(new URL('../../../../package.json', import.meta.url), 'utf-8');
  const shellPackage = await readFile(new URL('../../package.json', import.meta.url), 'utf-8');
  const zerops = await readFile(new URL('../../../../zerops.yaml', import.meta.url), 'utf-8');
  const coreBootstrap = await readFile(
    new URL(
      '../../../../packages/core-runtime/src/install/stage-context-bootstrap.ts',
      import.meta.url,
    ),
    'utf-8',
  );

  expect(JSON.parse(rootPackage).scripts['stage:bootstrap-demo']).toBe(
    'pnpm --filter @app/shell-super-app stage:bootstrap-demo',
  );
  expect(JSON.parse(shellPackage).scripts['stage:bootstrap-demo']).toBe(
    'node scripts/bootstrap-stage-demo.mts',
  );
  expect(zerops).not.toMatch(/start:.*stage:bootstrap-demo/u);
  expect(zerops).not.toMatch(/^\s*STAGE_DEMO_PASSWORD:/mu);
  expect(coreBootstrap).toMatch(/ULTRAMODERN_DEPLOYMENT_ENVIRONMENT/u);
  expect(coreBootstrap).toMatch(/buildRelationships/u);
});
