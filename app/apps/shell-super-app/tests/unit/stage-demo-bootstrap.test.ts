import { readFile } from 'node:fs/promises';

import { Effect } from 'effect';
import { expect, it } from 'effect-rstest';

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
it.effect('accepts the complete stage-only demo bootstrap configuration', () =>
  Effect.gen(function* acceptsTheCompleteStageonlyDemo() {
    expect(yield* parseStageDemoBootstrapConfig(validEnvironment)).toEqual({
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
  }),
);
it.effect('defines both exact stage accounts without storing their passwords', () =>
  Effect.sync(() => {
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
  }),
);
it.effect('refuses to provision outside stage or without an operator-supplied password', () =>
  Effect.gen(function* refusesToProvisionOutsideStage() {
    expect(
      yield* Effect.flip(
        parseStageDemoBootstrapConfig({
          ...validEnvironment,
          ULTRAMODERN_DEPLOYMENT_ENVIRONMENT: 'production',
        }),
      ),
    ).toMatchObject({ reason: expect.stringMatching(/stage environment/u) });
    expect(
      yield* Effect.flip(
        parseStageDemoBootstrapConfig({
          ...validEnvironment,
          STAGE_DEMO_PASSWORD: undefined,
        }),
      ),
    ).toMatchObject({
      reason: expect.stringMatching(/STAGE_DEMO_PASSWORD/u),
    });
    expect(
      yield* Effect.flip(
        parseStageDemoBootstrapConfig({
          ...validEnvironment,
          STAGE_SIAMPARK_PASSWORD: undefined,
        }),
      ),
    ).toMatchObject({
      reason: expect.stringMatching(/STAGE_SIAMPARK_PASSWORD/u),
    });
  }),
);
it.effect('treats an exact record as idempotent and rejects conflicting state', () =>
  Effect.gen(function* treatsAnExactRecordAsIdempotent() {
    const expected = {
      name: 'Techsio',
      slug: 'techsio',
      status: 'active',
    } as const;
    expect(yield* classifyExactStageDemoRecord('tenant', undefined, expected)).toBe('create');
    expect(yield* classifyExactStageDemoRecord('tenant', expected, expected)).toBe('existing');
    expect(
      yield* Effect.flip(classifyExactStageDemoRecord('tenant', { ...expected, name: 'Other tenant' }, expected)),
    ).toMatchObject({ reason: expect.stringMatching(/conflicts/u) });
  }),
);
it.live('keeps the demo bootstrap operator-invoked and excludes its password from source', () =>
  Effect.gen(function* keepsTheDemoBootstrapOperatorinvoked() {
    const rootPackage = yield* Effect.promise(() =>
      readFile(new URL('../../../../package.json', import.meta.url), 'utf-8'),
    );
    const shellPackage = yield* Effect.promise(() => readFile(new URL('../../package.json', import.meta.url), 'utf-8'));
    const bootstrapCommand = yield* Effect.promise(() =>
      readFile(new URL('../../scripts/bootstrap-stage-demo.sh', import.meta.url), 'utf-8'),
    );
    const zerops = yield* Effect.promise(() => readFile(new URL('../../../../zerops.yaml', import.meta.url), 'utf-8'));
    const coreBootstrap = yield* Effect.promise(() =>
      readFile(
        new URL('../../../../packages/core-runtime/src/install/stage-context-bootstrap.ts', import.meta.url),
        'utf-8',
      ),
    );
    const shellBootstrap = yield* Effect.promise(() =>
      readFile(new URL('../../api/auth/stage-demo-bootstrap-runtime-infrastructure.ts', import.meta.url), 'utf-8'),
    );
    expect(JSON.parse(rootPackage).scripts['stage:bootstrap-demo']).toBe(
      'pnpm --filter @app/shell-super-app stage:bootstrap-demo',
    );
    expect(JSON.parse(shellPackage).scripts['stage:bootstrap-demo']).toBe('sh scripts/bootstrap-stage-demo.sh');
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
  }),
);
