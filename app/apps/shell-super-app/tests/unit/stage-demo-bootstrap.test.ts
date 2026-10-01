import { Effect } from 'effect';
import { expect, it } from 'effect-rstest';

import {
  STAGE_DEMO_ACCOUNTS,
  STAGE_DEMO_RETIRED_ACCOUNT_EMAILS,
  classifyExactStageDemoRecord,
  parseStageDemoBootstrapConfig,
} from '../../api/auth/stage-demo-bootstrap-contract.ts';

const validEnvironment = {
  BETTER_AUTH_SECRET: 'stage-auth-secret-with-at-least-32-characters',
  BETTER_AUTH_URL: 'https://shell.stage.example.test',
  DATABASE_ADMIN_URL: 'postgresql://db:password@db:5432/db',
  SPICEDB_ENDPOINT: 'spicedb:50051',
  SPICEDB_PRESHARED_KEY: 'stage-spicedb-key',
  STAGE_AKROS_ADMIN_PASSWORD: 'test-only-akros-admin-password',
  STAGE_AKROS_DEMO_PASSWORD: 'test-only-akros-demo-password',
  STAGE_TECHSIO_ADMIN_PASSWORD: 'test-only-techsio-admin-password',
  STAGE_TECHSIO_DEMO_PASSWORD: 'test-only-techsio-demo-password',
  ULTRAMODERN_DEPLOYMENT_ENVIRONMENT: 'stage',
} as const;
it.effect('accepts the complete stage-only demo bootstrap configuration', () =>
  Effect.gen(function* acceptsTheCompleteStageonlyDemo() {
    expect(yield* parseStageDemoBootstrapConfig(validEnvironment)).toEqual({
      accounts: [
        {
          email: 'demo@test.com',
          password: 'test-only-techsio-demo-password',
          principalDisplayName: 'Techsio Demo',
        },
        {
          email: 'admin@techsio.test',
          password: 'test-only-techsio-admin-password',
          principalDisplayName: 'Techsio Admin',
        },
        {
          email: 'demo@akros.test',
          password: 'test-only-akros-demo-password',
          principalDisplayName: 'Akros Demo',
        },
        {
          email: 'admin@akros.test',
          password: 'test-only-akros-admin-password',
          principalDisplayName: 'Akros Admin',
        },
      ],
      authBaseUrl: 'https://shell.stage.example.test',
      authSecret: 'stage-auth-secret-with-at-least-32-characters',
      databaseAdminUrl: 'postgresql://db:password@db:5432/db',
    });
  }),
);
it.effect('defines the four exact stage accounts without storing their passwords', () =>
  Effect.sync(() => {
    expect(STAGE_DEMO_ACCOUNTS).toEqual([
      {
        email: 'demo@test.com',
        passwordEnvironmentKey: 'STAGE_TECHSIO_DEMO_PASSWORD',
        principalDisplayName: 'Techsio Demo',
      },
      {
        email: 'admin@techsio.test',
        passwordEnvironmentKey: 'STAGE_TECHSIO_ADMIN_PASSWORD',
        principalDisplayName: 'Techsio Admin',
      },
      {
        email: 'demo@akros.test',
        passwordEnvironmentKey: 'STAGE_AKROS_DEMO_PASSWORD',
        principalDisplayName: 'Akros Demo',
      },
      {
        email: 'admin@akros.test',
        passwordEnvironmentKey: 'STAGE_AKROS_ADMIN_PASSWORD',
        principalDisplayName: 'Akros Admin',
      },
    ]);
    expect(STAGE_DEMO_RETIRED_ACCOUNT_EMAILS).toEqual(['siampark01@test.com']);
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
    for (const key of [
      'STAGE_TECHSIO_DEMO_PASSWORD',
      'STAGE_TECHSIO_ADMIN_PASSWORD',
      'STAGE_AKROS_DEMO_PASSWORD',
      'STAGE_AKROS_ADMIN_PASSWORD',
    ] as const) {
      expect(
        yield* Effect.flip(parseStageDemoBootstrapConfig({ ...validEnvironment, [key]: undefined })),
      ).toMatchObject({
        reason: expect.stringMatching(new RegExp(key, 'u')),
      });
    }
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
