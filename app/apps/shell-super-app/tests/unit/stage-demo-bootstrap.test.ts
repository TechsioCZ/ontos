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
