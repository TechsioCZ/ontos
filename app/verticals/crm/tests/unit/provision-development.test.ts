import assert from 'node:assert/strict';
import test from 'node:test';
import { assertLocalDevelopmentTargets } from '../../scripts/provision-development.mts';

test('accepts explicit localhost PostgreSQL and insecure localhost SpiceDB targets', () => {
  assert.doesNotThrow(() =>
    assertLocalDevelopmentTargets({
      databaseUrl: 'postgresql://ontos:ontos@localhost:5433/ontos',
      nodeEnvironment: 'development',
      spiceDbEndpoint: 'localhost:50051',
      spiceDbInsecure: true,
    }),
  );
});

test('refuses production and non-local provisioning targets', () => {
  const base = {
    databaseUrl: 'postgresql://ontos:ontos@localhost:5433/ontos',
    nodeEnvironment: 'development',
    spiceDbEndpoint: 'localhost:50051',
    spiceDbInsecure: true,
  } as const;
  assert.throws(
    () => assertLocalDevelopmentTargets({ ...base, nodeEnvironment: 'production' }),
    /production/u,
  );
  assert.throws(
    () =>
      assertLocalDevelopmentTargets({
        ...base,
        databaseUrl: 'postgresql://ontos:ontos@database.example/ontos',
      }),
    /PostgreSQL/u,
  );
  assert.throws(
    () =>
      assertLocalDevelopmentTargets({
        ...base,
        spiceDbEndpoint: 'spicedb.example:443',
        spiceDbInsecure: false,
      }),
    /SpiceDB/u,
  );
});
