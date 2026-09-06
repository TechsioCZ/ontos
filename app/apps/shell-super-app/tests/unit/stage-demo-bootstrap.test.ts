import { readFile } from 'node:fs/promises';
import { inspect } from 'node:util';
import { expect, test } from '@rstest/core';
import { Effect, Redacted } from 'effect';
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
  const configuration = Effect.runSync(parseStageDemoBootstrapConfig(validEnvironment));
  expect(
    configuration.accounts.map(({ email, principalDisplayName }) => ({
      email,
      principalDisplayName,
    })),
  ).toEqual([
    {
      email: 'demo@test.com',
      principalDisplayName: 'Techsio Demo',
    },
    {
      email: 'siampark01@test.com',
      principalDisplayName: 'Siampark 01',
    },
  ]);
  expect(configuration.authBaseUrl).toBe('https://shell.stage.example.test');
  expect(Redacted.value(configuration.databaseAdminUrl)).toBe(
    'postgresql://db:password@db:5432/db',
  );
  expect(Redacted.isRedacted(configuration.authSecret)).toBe(true);
  expect(Redacted.value(configuration.authSecret)).toBe(
    'stage-auth-secret-with-at-least-32-characters',
  );
  expect(configuration.accounts.every(({ password }) => Redacted.isRedacted(password))).toBe(true);
  expect(Redacted.value(configuration.accounts[0].password)).toBe('test-only-bootstrap-password');
  expect(Redacted.value(configuration.accounts[1].password)).toBe('test-only-siampark-password');
  expect(JSON.stringify(configuration)).not.toMatch(
    /stage-auth-secret-with-at-least-32-characters|test-only-bootstrap-password|test-only-siampark-password/u,
  );
  expect(inspect(configuration)).not.toMatch(
    /stage-auth-secret-with-at-least-32-characters|test-only-bootstrap-password|test-only-siampark-password/u,
  );
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

test('returns typed safe failures for malformed and disallowed configuration values', () => {
  const cases = [
    ['BETTER_AUTH_SECRET', 'short', 'BETTER_AUTH_SECRET must contain at least 32 characters'],
    ['STAGE_DEMO_PASSWORD', 'short', 'STAGE_DEMO_PASSWORD must contain at least 8 characters'],
    [
      'STAGE_SIAMPARK_PASSWORD',
      'short',
      'STAGE_SIAMPARK_PASSWORD must contain at least 8 characters',
    ],
    ['BETTER_AUTH_URL', ' ', 'BETTER_AUTH_URL is required'],
    ['DATABASE_ADMIN_URL', undefined, 'DATABASE_ADMIN_URL is required'],
    ['BETTER_AUTH_URL', 'secret-invalid-url', 'The stage demo configuration is invalid'],
    ['DATABASE_ADMIN_URL', 'secret-invalid-url', 'The stage demo configuration is invalid'],
    ['BETTER_AUTH_URL', 'ftp://example.test', 'BETTER_AUTH_URL must be an HTTP origin'],
    ['BETTER_AUTH_URL', 'https://example.test/', 'BETTER_AUTH_URL must be an HTTP origin'],
    [
      'BETTER_AUTH_URL',
      'https://user:secret@example.test',
      'BETTER_AUTH_URL must be an HTTP origin',
    ],
    [
      'BETTER_AUTH_URL',
      'https://example.test?secret=value',
      'BETTER_AUTH_URL must be an HTTP origin',
    ],
    ['BETTER_AUTH_URL', 'https://example.test#secret', 'BETTER_AUTH_URL must be an HTTP origin'],
    [
      'DATABASE_ADMIN_URL',
      'https://user:secret@example.test',
      'DATABASE_ADMIN_URL must use PostgreSQL',
    ],
  ] as const;
  for (const [key, value, reason] of cases) {
    expect(
      Effect.runSync(
        Effect.flip(parseStageDemoBootstrapConfig({ ...validEnvironment, [key]: value })),
      ),
    ).toMatchObject({
      _tag: 'StageDemoBootstrapError',
      code: 'stage_demo_configuration_invalid',
      reason,
    });
  }
});

test('validates lazily, trims values and accepts both PostgreSQL schemes', () => {
  const environment = { ...validEnvironment, BETTER_AUTH_URL: 'not a URL' };
  const configuration = parseStageDemoBootstrapConfig(environment);
  environment.BETTER_AUTH_URL = ' http://localhost:3000 ';
  expect(Effect.runSync(configuration).authBaseUrl).toBe('http://localhost:3000');
  const trimmed = Effect.runSync(
    parseStageDemoBootstrapConfig({
      ...validEnvironment,
      DATABASE_ADMIN_URL: ' postgres://db:password@db:5432/db ',
      ULTRAMODERN_DEPLOYMENT_ENVIRONMENT: ' stage ',
      STAGE_DEMO_PASSWORD: ' password ',
    }),
  );
  expect(Redacted.value(trimmed.databaseAdminUrl)).toBe('postgres://db:password@db:5432/db');
  expect(trimmed.accounts.map(({ email }) => email)).toEqual([
    'demo@test.com',
    'siampark01@test.com',
  ]);
  expect(trimmed.accounts.map(({ password }) => Redacted.value(password))).toEqual([
    'password',
    validEnvironment.STAGE_SIAMPARK_PASSWORD,
  ]);
});

test('preserves unexpected environment access defects instead of reporting invalid configuration', () => {
  const defect = new Error('unexpected environment accessor failure');
  const environment = {
    ...validEnvironment,
    get BETTER_AUTH_SECRET(): string {
      throw defect;
    },
  };
  const configuration = parseStageDemoBootstrapConfig(environment);
  expect(
    Effect.runSync(
      Effect.catchDefect(Effect.flip(configuration), (cause) => Effect.succeed(cause)),
    ),
  ).toBe(defect);
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
