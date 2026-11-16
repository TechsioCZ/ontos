import { NodeCrypto } from '@effect/platform-node';
import { ConfigProvider, Effect, Schema } from 'effect';
import { describe, expect, it } from 'effect-rstest';
import {
  MeasureExecutionNativeFixtureError,
  seedMeasureExecutionNativeFixture,
} from '../support/measure-execution-native.ts';

const database = 'ontos_test_party_gateway_00000000000000000000000000000001';
const resourceRef = 'integration.symmy.job:10000000-0000-4000-8000-000000000005';
const input = {
  connections: {
    admin: {
      connectionString: `postgres://fixture-admin@127.0.0.1:1/${database}`,
      database,
      expectedRole: 'fixture-admin',
      host: '127.0.0.1',
      port: 1,
      user: 'fixture-admin',
    },
    runtime: {
      connectionString: `postgres://fixture-runtime@127.0.0.1:1/${database}`,
      database,
      expectedRole: 'fixture-runtime',
      host: '127.0.0.1',
      port: 1,
      user: 'fixture-runtime',
    },
  },
  contentScopeRef: `${resourceRef}#integration.symmy.job-intent`,
  governancePrincipalId: '10000000-0000-4000-8000-000000000003',
  legalEntityId: '10000000-0000-4000-8000-000000000002',
  resourceRef,
  tenantId: '10000000-0000-4000-8000-000000000001',
};

describe('native measure fixture isolation boundary', () => {
  it.effect('refuses unqualified or foreign content before opening a database connection', () =>
    Effect.gen(function* rejectWrongScope() {
      for (const contentScopeRef of [
        'integration.symmy.job-intent',
        'integration.symmy.job:20000000-0000-4000-8000-000000000005#integration.symmy.job-intent',
      ]) {
        const error = yield* Effect.flip(seedMeasureExecutionNativeFixture({ ...input, contentScopeRef }));
        expect(Schema.is(MeasureExecutionNativeFixtureError)(error)).toBe(true);
      }
      const error = yield* Effect.flip(seedMeasureExecutionNativeFixture({ ...input, resourceRef: 'foreign:job' }));
      expect(Schema.is(MeasureExecutionNativeFixtureError)(error)).toBe(true);
    }).pipe(Effect.provide(NodeCrypto.layer)),
  );
  it.effect('refuses base databases, same roles, mismatched hosts, and remote databases before I/O', () =>
    Effect.gen(function* rejectUnsafeDatabase() {
      const { connections } = input;
      const unsafe = [
        {
          ...connections,
          admin: { ...connections.admin, connectionString: 'postgres://fixture-admin@database.example:5432/ontos' },
        },
        { ...connections, admin: { ...connections.admin, database: 'ontos' } },
        { ...connections, runtime: { ...connections.runtime, user: connections.admin.user } },
        { ...connections, runtime: { ...connections.runtime, host: 'localhost' } },
        {
          admin: { ...connections.admin, host: 'database.example' },
          runtime: { ...connections.runtime, host: 'database.example' },
        },
      ];
      for (const pair of unsafe) {
        const error = yield* Effect.flip(seedMeasureExecutionNativeFixture({ ...input, connections: pair }));
        expect(Schema.is(MeasureExecutionNativeFixtureError)(error)).toBe(true);
      }
    }).pipe(
      Effect.provide(NodeCrypto.layer),
      Effect.provideService(ConfigProvider.ConfigProvider, ConfigProvider.fromUnknown({})),
    ),
  );
  it.effect('refuses production and stage execution before I/O', () =>
    Effect.gen(function* rejectDeployedExecution() {
      for (const stage of ['stage', 'production']) {
        const error = yield* Effect.flip(
          seedMeasureExecutionNativeFixture(input).pipe(
            Effect.provideService(
              ConfigProvider.ConfigProvider,
              ConfigProvider.fromUnknown({ ULTRAMODERN_DEPLOYMENT_ENVIRONMENT: stage }),
            ),
          ),
        );
        expect(Schema.is(MeasureExecutionNativeFixtureError)(error)).toBe(true);
      }
    }).pipe(Effect.provide(NodeCrypto.layer)),
  );
});
