import { readFile } from 'node:fs/promises';
import { expect, test } from '@rstest/core';
import { Effect } from 'effect';
import {
  STAGE_DEMO_ACCOUNTS,
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
  STAGE_SIAMPARK_PASSWORD: 'test-only-siampark-password',
  ULTRAMODERN_DEPLOYMENT_ENVIRONMENT: 'stage',
} as const;

test('accepts the complete stage-only demo bootstrap configuration', () => {
  expect(Effect.runSync(parseStageDemoBootstrapConfig(validEnvironment))).toEqual({
    accounts: [
      {
        email: 'demo@test.com',
        password: 'test-only-bootstrap-password',
        principalDisplayName: 'Techsio Demo',
      },
      {
        email: 'siampark01@test.com',
        password: 'test-only-siampark-password',
        principalDisplayName: 'Siampark 01',
      },
    ],
    authBaseUrl: 'https://shell.stage.example.test',
    authSecret: 'stage-auth-secret-with-at-least-32-characters',
    databaseAdminUrl: 'postgresql://db:password@db:5432/db',
  });
});

test('defines both exact stage accounts without storing their passwords', () => {
  expect(STAGE_DEMO_ACCOUNTS).toEqual([
    {
      email: 'demo@test.com',
      passwordEnvironmentKey: 'STAGE_DEMO_PASSWORD',
      principalDisplayName: 'Techsio Demo',
    },
    {
      email: 'siampark01@test.com',
      passwordEnvironmentKey: 'STAGE_SIAMPARK_PASSWORD',
      principalDisplayName: 'Siampark 01',
    },
  ]);
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
  expect(
    Effect.runSync(
      Effect.flip(
        parseStageDemoBootstrapConfig({
          ...validEnvironment,
          STAGE_SIAMPARK_PASSWORD: undefined,
        }),
      ),
    ),
  ).toMatchObject({ reason: expect.stringMatching(/STAGE_SIAMPARK_PASSWORD/u) });
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
  const bootstrapCommand = await readFile(
    new URL('../../scripts/bootstrap-stage-demo.sh', import.meta.url),
    'utf-8',
  );
  const zerops = await readFile(new URL('../../../../zerops.yaml', import.meta.url), 'utf-8');
  const coreBootstrap = await readFile(
    new URL(
      '../../../../packages/core-runtime/src/install/stage-context-bootstrap.ts',
      import.meta.url,
    ),
    'utf-8',
  );
  const shellBootstrap = await readFile(
    new URL('../../api/auth/stage-demo-bootstrap-runtime-infrastructure.ts', import.meta.url),
    'utf-8',
  );

  expect(JSON.parse(rootPackage).scripts['stage:bootstrap-demo']).toBe(
    'pnpm --filter @app/shell-super-app stage:bootstrap-demo',
  );
  expect(JSON.parse(shellPackage).scripts['stage:bootstrap-demo']).toBe(
    'sh scripts/bootstrap-stage-demo.sh',
  );
  expect(bootstrapCommand).toMatch(/stty -echo/u);
  expect(bootstrapCommand).toMatch(/STAGE_DEMO_PASSWORD/u);
  expect(bootstrapCommand).toMatch(/STAGE_SIAMPARK_PASSWORD/u);
  expect(zerops).not.toMatch(/start:.*stage:bootstrap-demo/u);
  expect(zerops).not.toMatch(/^\s*STAGE_DEMO_PASSWORD:/mu);
  expect(zerops).not.toMatch(/^\s*STAGE_SIAMPARK_PASSWORD:/mu);
  expect(coreBootstrap).toMatch(/ULTRAMODERN_DEPLOYMENT_ENVIRONMENT/u);
  expect(coreBootstrap).toMatch(/buildRelationships/u);
  expect(shellBootstrap).toMatch(/reconcileStageContextBootstraps/u);
  expect(shellBootstrap).not.toMatch(/contextKey/u);
});
